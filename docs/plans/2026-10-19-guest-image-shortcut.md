# Focused remote image paste shortcut

The user pressed Command+V directly on the Linux viewer and got a literal v. The existing image paste handlers only belong to the local file panel; noVNC maps macOS Command as a remote modifier instead of Linux Control. Keep the panel's manual action and add a focused-canvas Command+V path for graphical browser/desktop viewers, using the same authenticated image endpoint and click/key-triggered native image bridge.

Capture the trusted key before noVNC, suppress v down/up and repeat, release the remote Command-derived modifier, capture PNG then await verified transfer, and send Control+V only. Do not send Enter or submit an app action. A trusted image paste event on the same canvas can also deliver image data. Do not handle local inputs, translation/file panels, inactive tabs or CLI PTYs. No text/HTML/path fallback, passive reads or polling.

Cancel automatic paste if the view/environment/connection/focused canvas changes, the user clicks or types elsewhere, the document loses focus or becomes hidden. A client abort does not promise server rollback: a late verified image may remain in Linux clipboard, but must not send keys to a new focus. Show one compact pending/success or localized error message. Keep guard, receipts, image bounds, no-file transport, identity/resources and existing retained RFB behavior.

Validate production viewer plus real noVNC on owned synthetic RFB: literal v suppressed, remote modifiers released, Ctrl+V only after acknowledgment, no Enter, failures/repeats/focus changes/hidden views, local forms untouched, browser and desktop entry. No real AI pages or model calls. Build/package before asking to restart saved work.
