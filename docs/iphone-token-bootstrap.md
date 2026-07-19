# Bootstrap a myQ token from an iPhone

This procedure captures the one-time OAuth refresh token needed by
`homebridge-myq-camera` from the genuine myQ iOS app.

The proxy can read HTTPS traffic from the configured phone while its certificate
is trusted. Use a trusted private LAN, keep the capture window short, and do not
open unrelated apps during the procedure.

The proxy host may run macOS or Linux. It does not need to be the Homebridge
host, but the proxy host and iPhone must be on the same local network.

## Prepare the proxy host

### macOS

Install mitmproxy using its supported package or Homebrew:

```bash
brew install mitmproxy
```

Determine the Mac's Wi-Fi address with `ipconfig getifaddr en0`; try `en1` if
`en0` is blank. If the macOS firewall prompts when mitmdump starts, allow the
incoming connection for this private-network capture.

### Linux

Install mitmproxy using a supported distribution package or an isolated Python
application environment such as pipx. For example, when pipx is available:

```bash
python3 -m pipx install mitmproxy
```

Determine the address used on the iPhone's local network:

```bash
ip route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'
```

If a host firewall is active, permit inbound TCP port `8080` only from the
iPhone's local address for the duration of the capture. Remove that temporary
rule during cleanup.

### Common preparation

Create a private working directory on the proxy host:

```bash
mkdir -m 700 "$HOME/myq-camera-bootstrap"
cd "$HOME/myq-camera-bootstrap"
```

Copy `tools/capture_myq_token.py` from this repository into that directory.

## Start the proxy

Set `MYQ_IPHONE_IP` to the iPhone's current Wi-Fi address so the helper ignores
every other client:

```bash
MYQ_IPHONE_IP="IPHONE_LAN_ADDRESS" \
MYQ_TOKEN_OUT="$PWD/token.json" \
  mitmdump --listen-host 0.0.0.0 --listen-port 8080 \
  --scripts ./capture_myq_token.py
```

Do not add `-w` or otherwise save a mitmproxy flow file; it would contain
substantially more private data than the token file. If the iPhone cannot reach
the proxy, confirm both devices are on the same local network and check client
isolation and host-firewall settings before continuing.

## Configure the iPhone temporarily

1. Open the current Wi-Fi network's details and choose **Configure Proxy >
   Manual**. Enter the proxy host's local address and port `8080`.
2. In Safari, visit `http://mitm.it` and install the **iOS** mitmproxy profile.
3. Open **Settings > General > About > Certificate Trust Settings** and enable
   full trust for the mitmproxy certificate.
4. Visit `https://mitmproxy.org` in Safari. Stop if it does not load successfully
   through the proxy.

## Capture the token

1. Fully swipe-close the myQ app.
2. Reopen myQ, log out if necessary, and log back in.
3. Open one camera's live view for several seconds.
4. Wait for `Captured iOS myQ refresh token` in the proxy terminal.
5. Fully swipe-close myQ again.

The helper accepts only a successful token response from
`partner-identity.myq-cloud.com/connect/token` whose request identifies the
`IOS_CGI_MYQ` client. It writes only recognized OAuth fields and the non-secret
client identifier. It never prints token values.

Confirm the field names and private file mode without displaying the credential:

```bash
python3 -c 'import json,os; p="token.json"; print(sorted(json.load(open(p)))); print(oct(os.stat(p).st_mode & 0o777))'
```

The fields must include `refresh_token` and `client_id`; the expected mode is
`0o600`.

## Restore the iPhone and proxy host immediately

Complete every cleanup step before using the phone normally:

1. Set the iPhone Wi-Fi HTTP proxy back to **Off**.
2. Disable trust for the mitmproxy root certificate on the iPhone.
3. Remove the mitmproxy profile under **VPN & Device Management**.
4. Stop mitmdump with **Control-C**.
5. Remove any temporary proxy-host firewall rule.
6. Verify ordinary Safari and myQ access.

The proxy and certificate are not needed after this point.

## Install the token on the Homebridge host

First determine the Homebridge storage path and the account running Homebridge.
A local user-run installation commonly uses `~/.homebridge`; a service
installation commonly uses `/var/lib/homebridge`. Use the path reported by the
actual Homebridge installation rather than assuming either default.

### Homebridge on the proxy host

Run the following as the Homebridge account, replacing `STORAGE_PATH`:

```bash
STORAGE_PATH="$HOME/.homebridge"
install -d -m 700 "$STORAGE_PATH/myq-camera"
install -m 600 token.json "$STORAGE_PATH/myq-camera/token.json"
rm -f token.json
```

### Homebridge on another host

Transfer the token over SSH, then install it as the Homebridge account. Replace
the destination storage path as needed:

```bash
scp token.json homebridge-host:/tmp/myq-camera-token.json
ssh homebridge-host \
  'sudo install -d -o homebridge -g homebridge -m 0700 /var/lib/homebridge/myq-camera && sudo install -o homebridge -g homebridge -m 0600 /tmp/myq-camera-token.json /var/lib/homebridge/myq-camera/token.json && rm -f /tmp/myq-camera-token.json'
rm -f token.json
```

On the Homebridge host, set the actual storage path and validate the installed
token:

```bash
STORAGE_PATH="/var/lib/homebridge"
homebridge-myq-camera-doctor --storage-path "$STORAGE_PATH" --live 30
```

Run the doctor under the Homebridge account so it sees the same files and
permissions as the service. It should report both H.264 video and mu-law audio
frames. Keep the myQ app closed during this test because legacy TC-series
cameras allow only one native viewer session.

## Troubleshooting boundary

If Safari works through the proxy but the current myQ app produces no matching
token response, stop and perform the cleanup steps. The app, Cloudflare flow, or
certificate behavior may have changed. Do not distribute a private CA, retain a
broad capture, or bypass additional platform protections to force the result.
