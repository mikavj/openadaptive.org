# openadaptive.org

Source for the OpenAdaptive site, the home of a family of free, open
source assistive technology projects: the
[Open Adaptive Switch](https://github.com/mikavj/open-adaptive-switch),
a DIY Bluetooth accessibility switch, and
[Open Adaptive Stories](https://github.com/mikavj/open-adaptive-stories),
an app that turns photos into stories read aloud with that switch.

The site is plain HTML and CSS, hosted on GitHub Pages with a custom
domain.

## Layout

- `index.html`: the home page.
- `switch/`: overview of the switch. Its full site, support, and privacy
  policy live at [openadaptiveswitch.com](https://openadaptiveswitch.com),
  which stays the canonical address while the App Store listing points
  there.
- `stories/`: the stories app page, with its privacy policy and support
  page under `stories/privacy/` and `stories/support/`. These are the
  URLs for the App Store listing.
- `stories/app/`: a served copy of the stories web app. The canonical
  source is `open-adaptive-stories/docs/app`; refresh the copy with
  `scripts/sync-stories-app.sh` whenever the web app changes.
- `assets/`: the shared stylesheet, the OpenAdaptive mark, and the app
  icons.

## The mark

The brand mark is three spots in a row with the middle one highlighted
by the same ring and dot that appear in both app icons. Both apps are
built around that interaction: a highlight reaches a spot and one press
picks it.
`assets/logo.svg` is the source; the PNG favicon, touch icon, and social
image are rendered from it.

## Deploying

Pushing to the default branch publishes the site through GitHub Pages.
The `CNAME` file pins the custom domain. DNS for openadaptive.org points
at GitHub Pages with A and AAAA records for the apex and a `www` CNAME.

## License

GPL-3.0-or-later, like the rest of the OpenAdaptive projects.
