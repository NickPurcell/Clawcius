---
name: browser-cli
description: Look at a web page the way a person does — screenshot it to a PNG you can read, get its rendered text after JavaScript ran, or probe where a URL really lands. Use whenever you have built or changed a page, or need to see what a site shows rather than its raw HTML.
---

# browser-cli

`browse` drives a headless Chromium (Playwright) inside your container.

```
browse screenshot <url> <out.png> [--viewport WxH ...] [--full-page] [--scale N]
browse text       <url>          # rendered text, after JavaScript has run
browse html       <url>          # serialised DOM, after JavaScript has run
browse probe      <url>          # final URL, status, redirects, hosts contacted
```

The PNG is the point: you can read an image file directly, so look at what you
built before you say it is done. `--full-page` for a whole page, `--viewport
390x844` for a phone.

Exit codes: 0 ok · 1 usage · 2 browser missing or would not start · 3 navigation
failed · 4 timed out. Every navigation and every host contacted is logged.
