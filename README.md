<p align="center">
  <img src="assets/hero.png" alt="Volume Master. Louder when you need it. Leveled when you don't." width="1280">
</p>

# Volume Master

<p align="center">
  <a href="https://chromewebstore.google.com/detail/eodlhjkbanpiojkkpbkapolaglepomkp"><img src="https://img.shields.io/chrome-web-store/v/eodlhjkbanpiojkkpbkapolaglepomkp?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Chrome Web Store"></a>
</p>

Per-tab volume control for Chrome, from 0% to 2000%.

## Features

<table>
  <tr>
    <td align="center" width="50%">
      <img src="assets/gain.png" alt="Gain mode at 450 percent, with the limiter on" width="100%">
      <p>Set volume on one tab from 0% to 2000%, where 100% is native.</p>
    </td>
    <td align="center" width="50%">
      <img src="assets/compression.png" alt="Compression mode at a 55 percent target, with Intensity at 70" width="100%">
      <p>Compression mode levels toward a target RMS volume, with an Intensity knob.</p>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="assets/granular.png" alt="Granular mode at 250 percent, with slider stop ticks" width="100%">
      <p>Granular mode snaps the slider to preset stops.</p>
    </td>
    <td align="center" width="50%">
      <img src="assets/db.png" alt="Volume shown as plus 10.0 decibels" width="100%">
      <p>Volume can be shown in percent or decibels.</p>
    </td>
  </tr>
</table>

Bypass leaves a tab uncaptured until you move a control. Saved values return when capture resumes. The peak limiter at the end of the chain is on by default.

## Install

**From the store.** Open the [Chrome Web Store listing](https://chromewebstore.google.com/detail/eodlhjkbanpiojkkpbkapolaglepomkp) and add the extension.

**From source.** Build first. The Develop section has the commands. Then in `chrome://extensions` turn on Developer mode, choose **Load unpacked**, and select the `dist/` folder.

## Develop

```bash
npm install
npm run build
```

Output lands in `dist/`. Load that folder as an unpacked extension. After a change, run `npm run build` again. Then reload the extension in `chrome://extensions`.

`npm run watch` recompiles TypeScript on save. `npm run package` builds and writes a zip next to the project root.

## Release

Bump `version` in both `manifest.json` and `package.json`. Merge the change to `main`. The Release workflow tags the commit and publishes the zip as a GitHub Release.
