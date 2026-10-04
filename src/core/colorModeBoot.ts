/**
 * Color-mode bootstrap: must be imported BEFORE any module that pulls in
 * `@opentui/core` (it is the first import in `src/index.tsx`). OpenTUI's native
 * renderer reads the terminal's truecolor capability from the environment
 * around library load, so the decision has to happen at module-evaluation time,
 * not in `main()` (whose body runs after all static imports).
 *
 * See src/core/colorMode.ts for the policy. Keep this file free of runtime
 * imports (opentui/config/theme) so it evaluates first.
 */

import { applyColorMode } from "./colorMode.ts"

applyColorMode()
