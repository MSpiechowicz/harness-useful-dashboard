# [1.4.0](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.3.7...v1.4.0) (2026-10-06)


### Bug Fixes

* draw the trend line on weekly and monthly charts too ([19abe8d](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/19abe8d99ff9ac3b07e07aeedc23e4f0e8669c16))
* keep Settings working when the server is an older version ([6c4004f](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/6c4004f44cfa38bee5c93f1e8aab4b8a69e7d37b))
* show the total so far on Trends when there is nothing to compare ([d31c2bd](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/d31c2bd2d13aa2913256b44deee943bd7c804550))


### Features

* give Cline, Roo Code and Kilo Code each a source and a color of their own ([fe03228](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/fe032285cc906add2b1e2817f3ec95a8b7ee3287))
* read Zed's agent threads and the Cline, Roo Code and Kilo Code extensions ([b5a62e7](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/b5a62e7854fc36a6a1c42317f43b708202ee0a04))

## [1.3.7](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.3.6...v1.3.7) (2026-10-06)


### Bug Fixes

* stop the link address bubble covering the corner of the app window ([77fc65c](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/77fc65c11d31315701160ca1504454c372150b3b))

## [1.3.6](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.3.5...v1.3.6) (2026-10-06)


### Bug Fixes

* keep the menu button level with the first row of filters ([122de64](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/122de640e39725b0249e02550b310519dfe99a7f))
* show averages under the overview tiles when there is nothing to compare ([d684689](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/d684689bd410c739a43ebb4aba996f85b89192db))

## [1.3.5](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.3.4...v1.3.5) (2026-10-06)


### Bug Fixes

* show the app's icon on its window on Linux ([61c6166](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/61c61668131577fd419aa5e63b26d053e5d63e69))

## [1.3.4](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.3.3...v1.3.4) (2026-10-06)


### Bug Fixes

* open the macOS app window natively instead of under Rosetta ([28bf196](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/28bf1963a46823add332dfa46a231c37c773281c))

## [1.3.3](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.3.2...v1.3.3) (2026-10-06)


### Bug Fixes

* install updates where the app lives, and restart it after a CLI update ([68ab0de](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/68ab0dec9ec4bd7e6295d55bca5fd4247e09d8a9))

## [1.3.2](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.3.1...v1.3.2) (2026-10-06)


### Bug Fixes

* offer the update install in Settings and keep the sidebar notice current ([bb6cff4](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/bb6cff463a6950896fa59d811e7d52d1dfcdc744))

## [1.3.1](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.3.0...v1.3.1) (2026-10-06)


### Bug Fixes

* give the app its own icon on macOS, Linux and Windows ([9a7b00a](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/9a7b00aaf9e88a17b94d04d832d2456f77150d3f))

# [1.3.0](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.2.0...v1.3.0) (2026-10-06)


### Bug Fixes

* chart exactly the two windows the drift view compares ([d296202](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/d2962021290c56ac4d701b0f21116b878f12b0f1))
* drop needless decimals from the drift measures ([b7c676b](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/b7c676bbd76c79a2230c705cda3418734381c69b))
* explain the drift chart marks and trim repeated tile text ([f0d195b](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/f0d195b007abc8cff025fd3c863e49d926c24433))
* keep the client update switch apart from the drift chart legend ([c34f423](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/c34f4236093cd1718b7a12ec18e16f436652c03c))
* keep the fast-mode flag when a response streams over several lines ([b8e26d4](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/b8e26d4b533e7c84c9b56b5c89cfd6b155dde568))
* name the drift speed measure output token speed and show it per second ([1397520](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/1397520a11f0273738de145c06a994e3ac8cd6a2))
* show drift output speed in tok/s, the usual unit for model speed ([5e3336e](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/5e3336ec1df61d118f82c1f684efaa92fbc16944))
* show drift output speed in tokens per minute, as on the Live view ([d24bde2](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/d24bde2179e30a9748236b67e808fd3c9577aff9))
* show drift output speed in whole tokens per second ([59acfa3](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/59acfa30915499224f53f0e97dac92e2435f2d35))


### Features

* add a model drift view comparing each model with its own baseline ([74df896](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/74df89630fb94ee286868dadddd5866929f7800c))
* compare each model's recent responses with its own baseline ([16c3d8d](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/16c3d8ddbe593b62e8add88d0541ab0b2074defc))
* let the drift charts hide client update lines ([9af0935](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/9af0935276a267a33b20eb3437d48dbf12dc89a2))
* record response timing, effort, tool outcomes and interrupts ([be2e729](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/be2e729c53e6c17a40f8020f8a7656ea26aa7c4f))

# [1.2.0](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.1.0...v1.2.0) (2026-10-06)


### Bug Fixes

* keep recorded project paths as they are on Windows ([5033d9d](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/5033d9d5eb681bc068676005de22332864ad70f0))
* let the provider split donut fill its card on the overview ([bbf6f86](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/bbf6f863655fbd7bfddbe94559b5a3a5587343bc))


### Features

* add a live view with tokens per minute and plan limits left ([66bdbd7](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/66bdbd7e7a16d587d87ab732775f634b2d5011c1))
* add pi and OpenCode, plan limits from their logins, and Polish, French and Spanish ([4cf7576](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/4cf7576ccae5d254cba024a207991490a3752488))

# [1.1.0](https://github.com/MSpiechowicz/harness-useful-dashboard/compare/v1.0.0...v1.1.0) (2026-10-05)


### Features

* add omp support, a validated color palette, standard tables and a reworked settings page ([e5e225b](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/e5e225b9ef46e605f55515b9480edd8562394d32))

# 1.0.0 (2026-10-05)


### Features

* add initial gitignore file ([0ee7a6d](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/0ee7a6deb405e4d9a0d5d59734d9c49203528d52))
* add local token usage dashboard for Claude Code, Codex and Cursor ([5118d9a](https://github.com/MSpiechowicz/harness-useful-dashboard/commit/5118d9a505aab595e73e4acf822433c889222d5f))
