# Reporting a security problem

Email **tvara.exten@gmail.com** with `SECURITY` in the subject.

Please include what you found, how to reproduce it, and what you think the
impact is. If it is serious, say so in the subject line so it does not sit in a
support queue.

Please do not open a public issue for a vulnerability, and please give a
reasonable window to ship a fix before writing about it. Updates reach users
within hours of publishing, so that window is short.

## What is worth reporting

Tvara reads people's private conversations and holds an archive of them on
their own machine. The things that matter most:

- Anything that gets conversation text, an archive, or a licence key **off the
  user's device**
- Anything that lets a **web page** reach the extension's worker, storage, or
  archive. Page-world scripts communicate over `CustomEvent`, which any page can
  forge, so the listeners are a deliberate attack surface
- Anything that makes the extension call a host outside `host_permissions` with
  the user's session attached
- Anything that lets one user's licence be used as another's, or bypass the
  device limit at the licence server

## What is already known, and is not a finding

- **The source is readable.** Browser extensions install as plain files and
  Chrome's policies prohibit obfuscation. This is deliberate: software that
  reads private conversations should be inspectable by the people running it.
- **Paid features can be unlocked by editing the local copy.** Every
  client-side licence in existence can be patched by whoever controls the
  machine. Total Recall searches locally *because* there is no server to send
  conversations to, and that trade is intentional.
- **The extension attaches the user's own cookies** to requests to the AI sites
  they are signed into. That is how it reads their own history, it is scoped to
  the hosts in `host_permissions`, and the cookie goes only back to the site it
  came from.

## What we do

There is no bounty programme. There is a person who reads that inbox and will
reply.
