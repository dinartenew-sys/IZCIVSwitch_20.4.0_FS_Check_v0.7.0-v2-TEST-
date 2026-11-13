# NOTICE

## Upstream

This repository is an integration layer for
[civswitch-kit](https://gitee.com/mza1010/civswitch-kit). It does not claim
authorship of the Civ7 XSS, the ns2jb Stage 2 engine, or the CivSwitch loader.

- [civswitch-kit](https://gitee.com/mza1010/civswitch-kit) by mza1010 provides the filesystem support used by IZCIVSwitch. See the bundled [GPL-2.0 license](kit/LICENSE) and [upstream notices](kit/NOTICE.md).
- The CivSwitch port by [slapah](https://github.com/slapah) provides the ns2jb port layer.
- [kurumuz/ns2jb](https://gitlab.com/kurumuz/ns2jb) provides the upstream Stage 2 research (GPL-2.0).
- [Gezine/CivSwitch](https://github.com/Gezine/CivSwitch) provides the Civ7 XSS and loader portions. See the [MIT license notice](LICENSE-MIT-Gezine.txt).

The `kit/` directory is the original upstream source, included for
convenience. The kit's licenses and notices remain in force.

## Not included

- `prod.keys`, `title.keys`, or any console keys;
- the Switch 1 installer `civswitch-ldn-nx.nro`;
- firmware dumps or save backups;
- the full `iz2s-panel` platform. The `panel/` directory contains only the
  `CivSwitchLDN` component, its Linux x86_64 runtime, and the panel state
  needed for PC-side Lobby injection.

## CivSwitchLDN

The PC Lobby mode uses [CivSwitchLDN](https://github.com/ItsNerisma/CivSwitchLDN) by ItsNerisma. The bundled copy came from `iz2s-panel/iz2s-platform-run22`.

The bundled application and ItsNerisma's original code are licensed under [GPL-3.0-only](panel/engines/CivSwitchLDN/LICENSE). Reused components retain the licenses documented in the [bundled third-party notices](panel/engines/CivSwitchLDN/THIRD_PARTY_NOTICES.md).

## Bundled launcher package

`izlauncher/package/` contains an IZlauncher 0.27 build with the CivSwitch
loader embedded:

- [`LICENSE-CivSwitch.txt`](izlauncher/package/LICENSE-CivSwitch.txt) contains Gezine's MIT license notice.
- [`LICENSE-IZ2S.txt`](izlauncher/package/LICENSE-IZ2S.txt) contains the GPL-2.0 license for the IZ2S components.
- `boot.js`, `capsule-source.js`, `menu-capsule.bin`,
  `IZlauncher-027-FS.Civ7Save`, `pad-normalize.comp.spv`.

## License of the IZCIVSwitch integration

The original integration code is licensed under [GPL-2.0](LICENSE). Bundled projects retain their respective licenses.

## Safety

Research only, on hardware you own. A failed fs race or a wedged console is an
expected failure mode; hard power-cycle the console. Do not use this on other
people's devices or in online play. No warranty.
