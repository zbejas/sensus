/**
 * attachPicker — the boot re-attach candidate list (P4c; D4). Lists live
 * shells/chats over a real daemon and degrades to [] when it is unreachable.
 */

import { describe, expect, test } from "bun:test"
import { listAttachCandidates, listChats, listShells, type AttachCandidate } from "../../../src/client/attachPicker.ts"
import { candidateTarget, loneAttachTarget, shouldAskAttach } from "../../../src/client/bootPicker.ts"
import { WsClient } from "../../../src/client/wsClient.ts"
import { startTestDaemon } from "./support.ts"

/** A minimal candidate for the pure boot-picker reductions. */
function candidate(over: Partial<AttachCandidate>): AttachCandidate {
  return {
    kind: "shell",
    id: "s1",
    shellId: "s1",
    title: "",
    status: "alive",
    attached: false,
    alive: true,
    empty: false,
    lastDetachedAt: null,
    ...over,
  }
}

describe("attachPicker", () => {
  test("lists an opened shell as a re-attach candidate; empty chats are marked and sorted last", async () => {
    const daemon = await startTestDaemon()
    const client = new WsClient({
      runtimeDir: daemon.runtime,
      token: daemon.token,
      port: daemon.result.tcp.port,
      reconnect: false,
      requestTimeoutMs: 8000,
    })
    try {
      await client.waitForHello(8000)
      expect((await listAttachCandidates(client)).candidates).toEqual([])

      const opened = await client.terminal.open({ cols: 80, rows: 24 })
      const result = await listAttachCandidates(client)
      expect(result.shells.length).toBe(1)
      const candidate = result.candidates.find((c) => c.kind === "shell" && c.id === opened.shellId)
      expect(candidate).toBeDefined()
      expect(candidate?.alive).toBe(true)
      expect(candidate?.attached).toBe(false)

      // Binding a chat moves the shell out of the "shell" bucket and into the
      // "chat" bucket. An UNSENT chat is still a candidate (marked `empty`) so a
      // lone idle pane is re-attached silently rather than abandoned.
      const openedChat = await client.chat.open({ shellId: opened.shellId })
      const withChat = await listAttachCandidates(client)
      expect(withChat.candidates.some((c) => c.kind === "shell" && c.id === opened.shellId)).toBe(false)
      expect(withChat.chats.find((c) => c.chatId === openedChat.chatId)?.empty).toBe(true)
      expect(
        withChat.candidates.some((c) => c.kind === "chat" && c.id === openedChat.chatId && c.empty),
      ).toBe(true)

      // Once it has content (even a local /help turn), it is a normal candidate.
      await client.chat.send({ chatId: openedChat.chatId, text: "/help" })
      const nonEmpty = await listAttachCandidates(client)
      expect(nonEmpty.chats.find((c) => c.chatId === openedChat.chatId)?.empty).toBe(false)
      expect(
        nonEmpty.candidates.some((c) => c.kind === "chat" && c.id === openedChat.chatId && !c.empty),
      ).toBe(true)

      // Empty chats stay candidates (the pane is live) but sort AFTER chats with
      // content so they cannot be mistaken for a resumable session.
      const second = await client.terminal.open({ cols: 80, rows: 24 })
      const secondChat = await client.chat.open({ shellId: second.shellId })
      const ordered = (await listAttachCandidates(client)).candidates
      const ids = ordered.map((c) => c.id)
      expect(ids.indexOf(openedChat.chatId)).toBeLessThan(ids.indexOf(secondChat.chatId))
      expect(ordered.find((c) => c.id === secondChat.chatId)?.empty).toBe(true)

      await client.terminal.kill({ shellId: second.shellId })
      await client.terminal.kill({ shellId: opened.shellId })
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("an unreachable daemon yields empty lists, never throws", async () => {
    const client = new WsClient({
      host: "127.0.0.1",
      port: 1,
      token: "bogus",
      reconnect: false,
      requestTimeoutMs: 200,
    })
    try {
      expect(await listShells(client)).toEqual([])
      expect(await listChats(client)).toEqual([])
      expect((await listAttachCandidates(client)).candidates).toEqual([])
    } finally {
      client.close()
    }
  }, 30000)

  test("a pane inactive past the re-attach window is not offered", async () => {
    const daemon = await startTestDaemon()
    const client = new WsClient({
      runtimeDir: daemon.runtime,
      token: daemon.token,
      port: daemon.result.tcp.port,
      reconnect: false,
      requestTimeoutMs: 8000,
    })
    try {
      await client.waitForHello(8000)
      const opened = await client.terminal.open({ cols: 80, rows: 24 })
      // A large window keeps a freshly-opened pane a candidate.
      const recent = await listAttachCandidates(client, 60 * 60 * 1000)
      expect(recent.candidates.some((c) => c.id === opened.shellId)).toBe(true)
      expect(recent.shells.find((s) => s.shellId === opened.shellId)?.lastDetachedAt).not.toBeNull()

      // Let the pane sit a moment, then a 1ms window marks it too old.
      await Bun.sleep(20)
      const stale = await listAttachCandidates(client, 1)
      expect(stale.candidates.some((c) => c.id === opened.shellId)).toBe(false)
      // Window 0 = no limit: still offered (the default).
      expect((await listAttachCandidates(client, 0)).candidates.some((c) => c.id === opened.shellId)).toBe(true)

      await client.terminal.kill({ shellId: opened.shellId })
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)
})

describe("bootPicker reductions", () => {
  test("candidateTarget maps a chat candidate to its own id; a shell opens a fresh chat", () => {
    expect(candidateTarget(candidate({ kind: "chat", id: "c1", shellId: "s1", title: "hi" }))).toEqual({
      shellId: "s1",
      chatId: "c1",
      title: "hi",
    })
    // A bare shell: chatId null (the app opens a fresh chat on attach); an
    // empty title is omitted rather than carried as "".
    expect(candidateTarget(candidate({ kind: "shell", id: "s1", shellId: "s1", title: "" }))).toEqual({
      shellId: "s1",
      chatId: null,
    })
    // A shell whose own id is the target when shellId is null.
    expect(candidateTarget(candidate({ kind: "shell", id: "s9", shellId: null }))).toEqual({
      shellId: "s9",
      chatId: null,
    })
  })

  test("a lone candidate is auto-attached; none/several require the window", () => {
    expect(loneAttachTarget([])).toBeNull()
    expect(shouldAskAttach([])).toBe(false)
    const one = candidate({ kind: "chat", id: "c1", shellId: "s1", title: "only" })
    expect(loneAttachTarget([one])).toEqual({ shellId: "s1", chatId: "c1", title: "only" })
    expect(shouldAskAttach([one])).toBe(false)
    const two = [candidate({ id: "s1" }), candidate({ id: "s2" })]
    expect(loneAttachTarget(two)).toBeNull()
    expect(shouldAskAttach(two)).toBe(true)
  })
})
