import { describe, expect, test } from "bun:test"
import { isFileListMime, parseFileUriList } from "../../../../src/ui/lib/clipboard.ts"

describe("clipboard file list", () => {
  test("isFileListMime recognizes uri-list bodies (parameters ignored)", () => {
    expect(isFileListMime("text/uri-list")).toBe(true)
    expect(isFileListMime("text/uri-list; charset=utf-8")).toBe(true)
    expect(isFileListMime("x-special/gnome-copied-files")).toBe(true)
    expect(isFileListMime("text/plain")).toBe(false)
    expect(isFileListMime("image/png")).toBe(false)
  })

  test("parseFileUriList decodes file URLs, skips comments/non-file lines, drops the authority", () => {
    const body = [
      "# copied files",
      "file:///home/me/notes.txt",
      "file://localhost/home/me/pic%20one.png",
      "file://host/share/a.txt",
      "https://example.com/not-a-file",
      "",
      "file:///home/me/caf%C3%A9.md",
    ].join("\r\n")
    expect(parseFileUriList(body)).toEqual([
      "/home/me/notes.txt",
      "/home/me/pic one.png",
      "/share/a.txt",
      "/home/me/café.md",
    ])
  })

  test("gnome-copied-files: the leading action line is skipped like a comment", () => {
    const body = "copy\nfile:///tmp/a.txt\nfile:///tmp/b%2Bc.txt"
    expect(parseFileUriList(body)).toEqual(["/tmp/a.txt", "/tmp/b+c.txt"])
  })

  test("a bare file URL without a path yields nothing; a malformed escape keeps the raw path", () => {
    expect(parseFileUriList("file://")).toEqual([])
    expect(parseFileUriList("file://host")).toEqual([])
    expect(parseFileUriList("file:///tmp/100%.txt")).toEqual(["/tmp/100%.txt"])
  })
})
