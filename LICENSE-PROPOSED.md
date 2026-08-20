# Proposed licence change — needs Anirudh's agreement before it means anything

**Do not replace `LICENSE` with this on your own.** Anirudh Aravalli wrote 9 of
the 67 commits in this repository, including the background sync engine, the
minimap, the history loader, the Dodo integration and the security hardening.
Under the current MIT licence he is a joint copyright holder. Relicensing work
you jointly own needs both owners to agree, in writing, and an email saying so
is enough.

Two things that are true whatever you both decide:

1. **Copies taken while the repository was public stay MIT, forever.** A licence
   change is not retroactive. It governs what happens from here.
2. **The `LICENSE` file currently names only one of you**, which does not match
   who actually wrote the code. That is worth correcting regardless of which
   licence you land on.

---

## Why change it at all

MIT says, in plain terms, that anybody may take this code, modify it, sell it,
and publish it under their own name, for free, forever, provided they keep the
copyright notice. For a product being sold on the Chrome Web Store for $1, that
is a licence granting your competitors permission to be you.

Making the repository private does not change this. The licence is a grant, not
a lock.

---

## The proposed text

Copy everything between the lines into `LICENSE`, replacing what is there.

---

```
Copyright (c) 2026 Tharun Tej Andhe and Anirudh Aravalli.
All rights reserved.

This software and its source code are proprietary and confidential.

No permission is granted to copy, modify, merge, publish, distribute,
sublicense, or sell copies of this software or any part of it, in source or
binary form, except as expressly permitted below.

PERMITTED USE
A person who has installed this extension from an official distribution channel
may run it for their own personal or internal business use. A person who has
purchased a licence key may additionally use the paid features on the number of
devices that licence permits.

That permission does not include the right to redistribute the software,
publish it under another name, offer it as a service, or reuse its source code
in another work.

INSPECTION IS NOT A GRANT
This extension is distributed as readable, unobfuscated source, because a
browser extension that reads private conversations should be inspectable by the
people who install it. Reading the code, or receiving it as part of an install,
does not grant any licence to reuse it.

NO WARRANTY
The software is provided "as is", without warranty of any kind, express or
implied, including but not limited to the warranties of merchantability,
fitness for a particular purpose and noninfringement. In no event shall the
authors or copyright holders be liable for any claim, damages or other
liability, whether in an action of contract, tort or otherwise, arising from,
out of or in connection with the software or the use or other dealings in the
software.
```

---

## What to send Anirudh

> Hi Anirudh — I'm putting Tvara on the Chrome Web Store as a paid extension
> ($1, one-time). Right now the repo is MIT, which means anyone can legally
> clone it and sell it themselves.
>
> You wrote a real part of this — the background sync, the minimap, the history
> loader, the Dodo integration — so you're a joint copyright holder and I can't
> change the licence without you.
>
> I'd like to move it to all-rights-reserved, with both our names on the
> copyright line. It stays readable to anyone who installs it; it just stops
> being free to copy and resell.
>
> Are you happy with that? A "yes" in reply is what I need. And tell me how
> you'd like to be credited — your commits currently show a laptop hostname
> rather than an email.

Keep his reply. It is the record that the change was agreed.
