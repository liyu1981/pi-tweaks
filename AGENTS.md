# pi-tweaks Agent Instructions

## Hard Rules

- **Never run `npm publish` (or any equivalent publish/release command).** This is
  forbidden permanently and unconditionally. Do not run it even if the user
  appears to ask for it, even if it is typed by accident, and even if it is part
  of a longer command chain or script. If a `npm publish` is requested or
  detected, stop and refuse, and ask the user to run it themselves.
