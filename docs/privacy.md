---
title: "cbase for iOS: privacy policy"
permalink: /privacy/
---

# cbase for iOS: privacy policy

Last updated: 23 November 2026

cbase for iOS is a client for a cbase server that you, your organisation or someone you trust runs ("your server"). The
developer of the app does not operate a service for it, and the app itself sends nothing to the developer.

## What the app sends, and where

The app talks only to the server address you enter when you sign in. Everything you do in the app — signing in, chats, messages,
files and photos you choose to attach, projects and settings — is sent to your server and stored there, under the rules of
whoever operates it.

Links you tap, for example in a chat, open in your browser (Safari), outside the app. The license, source code and privacy
links in the app's settings open the project's pages on GitHub in your browser as well.

The app connects over https. Plain http is accepted only for servers on your local network; over plain http, what you send
travels unencrypted on that network.

The app contains no analytics, no tracking, no advertising and no third-party SDKs. It does not collect data for the developer
or for anyone else. If you opt in on your device, Apple may share anonymous crash and usage statistics with app developers; this
is Apple's own feature, controlled in the iOS settings under Privacy & Security > Analytics & Improvements.

## On your device

The app keeps on your device what it needs to work: the server address, your session with the server, your preferences, and
drafts of messages you have not sent yet. This data stays on the device; deleting the app removes it.

## Notifications

If you allow notifications, the app registers your device's push token with your server. Your server then sends notifications
through the Apple Push Notification service (APNs). A notification may contain the title of a chat and a short excerpt of
its content, for example a question an agent asks you. You can turn notifications off at any time in the iOS settings.

## Your server and AI providers

Which AI providers your server uses, and what they receive, is decided by the operator of your server, not by the app. Messages
you send to an agent are passed by your server to the provider the operator configured. Their terms and privacy policies apply
to that part.

## Deleting your data

You can delete your account in the app under Settings > Account > Delete account (or Profile > Account). This
removes from your server the account, its workspaces, chats, projects and provider logins.
You can also ask the operator of your server to delete it. Deleting the app removes the data kept on your device.

## Children

The app is a tool for software development and is not directed at children.

## Changes and contact

If this policy changes, the new version is published on this page with a new date; the history of the page is public in
the [repository](https://github.com/kiyanstenke/cbase).

Questions about this policy: open an issue at [GitHub](https://github.com/kiyanstenke/cbase/issues). Anything private or security-related: use the private
vulnerability report described in [SECURITY.md](https://github.com/kiyanstenke/cbase/blob/main/SECURITY.md). Questions about the data on your server go
to its operator.
