# Historical audit pointer

This path previously held a milestone snapshot from before trusted assets, portable packages,
audio/captions, authored render profiles, and the final V1 qualification work. Its command counts and
capability statements are now stale and must not be used as current release evidence. The historical
text remains recoverable from Git history.

Use [`V1_AUDIT.md`](./V1_AUDIT.md) as the sole current qualification ledger. It freezes the exact
local and prepublication receipts while leaving release-SHA, clean-clone, remote-main, and
annotated-tag receipts external to the immutable release payload. Verify those publication receipts
directly from the remote refs. No hosted production deployment is claimed without a verified live URL.
