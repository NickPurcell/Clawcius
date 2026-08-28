# Squid egress proxy

The agent container is on a Docker `--internal` network with no route out;
Squid, on both that network and one with a route, is the only way to the
internet, so the proxy variables the container carries are not advice. Squid
filters on the CONNECT target — no TLS interception, no CA key.

Policy is **default-allow with a blocklist** (`squid.conf` §5). Today the list
blocks nothing: its one entry, `.invalid`, keeps the ACL parseable. It is a
kill switch for a destination that turns out to be a problem, not a boundary.
Ports other than 80 and 443 are refused, and so are the host's loopback and the
private ranges as resolved destinations.

## Change the policy

Edit the `clawcius-blocklist-begin … end` block in `squid.conf`, then
`docker/up.sh`, which rebuilds the Squid image from a temporary context and
recreates the container. The agent container is not touched.

## Verify

```sh
docker exec clawcius-agent curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/   # 200
docker exec clawcius-agent curl -s -o /dev/null -w '%{http_code}\n' https://example.com:8080/  # 403: port
docker exec clawcius-agent curl -s -o /dev/null -w '%{http_code}\n' http://172.17.0.1/         # 403: private
docker logs clawcius-squid | grep TCP_DENIED
```

Memory: ~100 MB with caching off. Logs go to `docker logs clawcius-squid`.
