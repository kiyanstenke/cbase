---
title: "cbase for iOS: support"
permalink: /support/
---

# cbase for iOS: support

The app needs a cbase server. If you cannot sign in, check the server address with your server's operator first.

## Questions, bugs, feature requests

Open an issue at [GitHub](https://github.com/kiyanstenke/cbase/issues). Please include the app version (the version shown in Settings > About), your iOS version and
the steps that lead to the problem. Never include passwords, tokens or other personal data in an issue.

## Security problems and anything private

Use **Report a vulnerability** under the **Security** tab of the repository, as described in
[SECURITY.md](https://github.com/kiyanstenke/cbase/blob/main/SECURITY.md). The project publishes no email address.

## Running your own server

Start with the [README](https://github.com/kiyanstenke/cbase#readme) and [server/README.md](https://github.com/kiyanstenke/cbase/blob/main/server/README.md).

## Notifications

Notifications reach the app through the Apple Push Notification service, sent by your server. The App Store build of the app
only receives them from servers configured with the publisher's push key; a server you set up yourself without that key can
still be used in full, but its notifications will not arrive in the App Store build. If notifications stop on a server that
did send them, check that notifications are allowed for cbase in the iOS settings, then ask your server's operator.

## Privacy

See the [privacy policy](../privacy/).

cbase is a volunteer open-source project; there is no fixed response time.
