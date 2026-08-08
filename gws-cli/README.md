# gws-cli

`gdoc` — read and edit Google Docs from the command line, for the agent to drive.

```
gdoc setup                                  # the four setup steps, on demand
gdoc whoami                                 # the address to share docs with
gdoc list                                   # docs shared with the service account
gdoc read   <url|id> [--title-only]
gdoc append <url|id> [-t TEXT]              # omit -t to read stdin
gdoc replace <url|id> --find X --replace Y [--ignore-case]
```

Takes a full Docs URL or a bare document ID.

## No dependencies, deliberately

Pure stdlib, like `discord-cli`. The tool is bind-mounted read-only into the
agent container and has to work the moment it lands, with no install step.

An earlier version used `google-auth` in a virtualenv under the container's
home directory. A VPS migration deleted that home, and the tool with it. Being
stdlib-only means the mount *is* the install.

That constraint means signing the service-account JWT by hand — RSA PKCS#1
v1.5 over SHA-256, which Python's big integers do natively. PKCS#1 v1.5 is
deterministic, so the implementation is checkable: the same input must produce
the byte-identical signature any correct implementation produces. It was
verified against `cryptography` across 2048- and 3072-bit keys, both PKCS#8 and
PKCS#1 PEM encodings, and message lengths from empty to 5 KB.

It also sidesteps a trap worth recording. `google-api-python-client`'s httplib2
transport ignores `http_proxy`/`https_proxy`, and the agent container has no
direct route out — DNS included. The symptom is `unable to find the server at
oauth2.googleapis.com` on a host where `curl` works fine. `urllib` reads the
proxy environment by default.

## Why a service account

There is no browser in the container to complete an OAuth consent screen, and a
refresh token minted elsewhere would have to be pasted through a chat log to
arrive.

A service account is its own Google identity with an empty Drive. It sees
nothing until a document is shared with its address, exactly like sharing with
a colleague — so it can never quietly reach the rest of the owner's Drive, and
revoking is one click.

## Setup

1. Google Cloud console — create or pick a project.
2. Enable the **Google Docs API** and the **Google Drive API** in it.
3. IAM & Admin → Service Accounts → Create. Then Keys → Add key → Create new
   key → JSON. No IAM roles are needed; access comes from document sharing.
4. Put the JSON on the host at `secrets/gws-service-account.json` (override
   with `GWS_KEY`). `run-container.sh` mounts it read-only at
   `~/.config/gws/service-account.json`, and skips the mount with a note when
   it is absent.

Then `gdoc whoami`, and share the document with the address it prints, as an
Editor.

Do not paste the key into chat. Step 4 exists so it never has to be.

## Credentials lookup

1. `$GWS_SA_KEY`
2. `~/.config/gws/service-account.json`
