# agpl-office-apps

Public **corresponding source** for the AGPL-licensed apps that Amplify
(amplify.is, operated by Guðmundur Eyberg Kristjánsson) offers to users over a
network — on Amplify itself and inside apps that Amplify builds for customers.

Under the GNU Affero General Public License v3 (§13), anyone who uses one of
these apps over a network may obtain its complete corresponding source. This
repository is where that source lives:

- **Modified versions included.** Every Amplify change (for example, replacing
  the original cloud backend with Amplify storage and sign-in adapters) is
  published here, not only the upstream code.
- **Customer apps included.** When an AGPL app runs inside or for an
  Amplify-built customer app, the exact source of the version it runs is here.
- **Exact versions.** Each deployed version has a git tag
  (`<app>-<env>-<shortsha>`, e.g. `spreadsheet-stg-1a2b3c4`) that matches the
  version shown on the running service's `/source` page.

Each app lives in its own directory (`apps/<name>/`) with its own `LICENSE`
(AGPL-3.0-only unless stated otherwise) and a `MODIFICATIONS.md` listing what
Amplify changed and when. AGPL apps run as separate, isolated services; they are
not compiled into Amplify's own (non-AGPL) code.

Status: **no app published yet.** The first planned app is the spreadsheet from
[HeyPuter/everything](https://github.com/HeyPuter/everything) (`src/spreadsheet`).

Licence: [GNU AGPL-3.0](LICENSE). Third-party and upstream notices: [NOTICE](NOTICE).
Contact: hello@amplify.is
