# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, and do not include real API keys in a report.

We will acknowledge your report and keep you informed while we work on a fix.

## Scope

This repository contains the Reka provider plugin for OpenClaw. In scope:

- How the plugin handles your Reka API key. It is read through OpenClaw's own auth and is only ever sent to `https://api.reka.ai/v1` (or a loopback address you configure explicitly).
- The plugin's network requests: `GET /v1/models` for the model list, and chat requests made through OpenClaw's transport.
- The release workflows in `.github/workflows/`.

Vulnerabilities in OpenClaw itself should be reported to the OpenClaw project, and issues with the Reka API to Reka support.

## Supported versions

Security fixes are released for the latest published version only.
