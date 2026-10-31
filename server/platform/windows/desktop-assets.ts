import type {DesktopAppId} from '../../../shared/guest-desktop.ts';
import {AppError} from '../../errors.ts';
import {WINDOWS_CLAUDE_DESKTOP} from './desktop-assets-claude.ts';
export {WINDOWS_CLAUDE_DESKTOP} from './desktop-assets-claude.ts';

export interface WindowsDesktopAsset {
 readonly id:DesktopAppId;readonly version:string;readonly architecture:'amd64';readonly bytes:number;readonly sha256:string;readonly url:string;
 readonly prefix:string;readonly executable:string;readonly sandbox:string;
 readonly files:Readonly<Record<string,Readonly<{bytes:number;sha256:string;executable:boolean}>>>;
}

// Independently read fixed official AMD64 archive bytes. No client runtime or
// product entry is enabled by this catalog. Client and guest acceptance remain pending.
export const WINDOWS_GROK_DESKTOP={
  "id": "grok-bot",
  "version": "0.68.1",
  "architecture": "amd64",
  "bytes": 104614112,
  "sha256": "b2be8106d2b3eae07d983d5f1ca77b657accde666dc440db2a409421ecff3359",
  "url": "https://downloads.cursor.com/grokbot/stable/33103062f95061ccf9c81c5b365d37ab152c3b66/linux/x64/grok-bot_0.68.1_amd64.deb",
  "prefix": "opt/Grok Bot/",
  "executable": "grok-bot",
  "sandbox": "chrome-sandbox",
  "files": {
    "LICENSE.electron.txt": {
      "bytes": 1096,
      "sha256": "5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d",
      "executable": false
    },
    "LICENSES.chromium.html": {
      "bytes": 20008180,
      "sha256": "5a3889308cd43c659bf937864332cc973a556801dd7a66a444bde9f5112a6a89",
      "executable": false
    },
    "chrome-sandbox": {
      "bytes": 15232,
      "sha256": "2015304df43beff0b74409cdc4d858107efcde650d9bc8afb1288041d62cec4b",
      "executable": true
    },
    "chrome_100_percent.pak": {
      "bytes": 120284,
      "sha256": "8101a69055892144e1cf01ab238e53b04e579df73da656afa43102d1692b132e",
      "executable": false
    },
    "chrome_200_percent.pak": {
      "bytes": 198601,
      "sha256": "51cf8ae50f3eefa702c9bd6782c52291e6bdac644da9eecda1bd2e0745acb3f7",
      "executable": false
    },
    "chrome_crashpad_handler": {
      "bytes": 1570368,
      "sha256": "2c422808032670bd5d0713e6a240a923897e056c0c06f6c19adbb91340d559bd",
      "executable": true
    },
    "grok-bot": {
      "bytes": 210087128,
      "sha256": "f41a171f676da01f1a126e24e9fbfeb7af6d17456e924f3f9831ec637886d79c",
      "executable": true
    },
    "icudtl.dat": {
      "bytes": 11002272,
      "sha256": "fb516762119df8bd8368e2f875a151ba06972504893166ca8f7b675b47f78ec2",
      "executable": false
    },
    "libEGL.so": {
      "bytes": 286424,
      "sha256": "53fa6ba8954118f298b0da54ad70b282128250eb1151ec1eb8ef73ff75e8b479",
      "executable": true
    },
    "libGLESv2.so": {
      "bytes": 6428384,
      "sha256": "981cc3d8d5e84db25aab8231d06c555e4f5780ff17bd7c022ab6cf9f65db7fbd",
      "executable": true
    },
    "libffmpeg.so": {
      "bytes": 2752696,
      "sha256": "f5f717853cf22bf28b1446545c892681c9d79053b3d499dc728c08783644e6c6",
      "executable": true
    },
    "libvk_swiftshader.so": {
      "bytes": 4471288,
      "sha256": "7c612f40eaf18d25c6cb41ab33b73287b911804a48bfc9ef9f6320cc880bf013",
      "executable": true
    },
    "libvulkan.so.1": {
      "bytes": 2540808,
      "sha256": "8b07fc43b1432fe51f70a7a19b509b105a3a9d96f151868f6084092d05821a84",
      "executable": true
    },
    "locales/af.pak": {
      "bytes": 610566,
      "sha256": "5a4419da8452ae7d16e14752232c06c5a68709c5ed14b54a7684a7e47a450225",
      "executable": false
    },
    "locales/am.pak": {
      "bytes": 991660,
      "sha256": "e5cca36213fbf78cf09c86c9ff4ccc6e1cf120c50a2857bbee4c00f8112e7f35",
      "executable": false
    },
    "locales/ar.pak": {
      "bytes": 1095222,
      "sha256": "206717373943782e03363d90374c14d0ab41ed3812715485355b5f5841beb19d",
      "executable": false
    },
    "locales/bg.pak": {
      "bytes": 1132052,
      "sha256": "d94bdcda005b093bc885b4bbbaa11c131c3e5b2a2b7b018494f300f12b47fbcc",
      "executable": false
    },
    "locales/bn.pak": {
      "bytes": 1456768,
      "sha256": "1b9f9ccf614133082ba286696fd81f48b42de7372d60cba1f621aaa75eaa1c00",
      "executable": false
    },
    "locales/ca.pak": {
      "bytes": 688736,
      "sha256": "1c19b5099e0cf6a1d387189d3684cf806de38aad336856291539f002ce2c89cb",
      "executable": false
    },
    "locales/cs.pak": {
      "bytes": 715321,
      "sha256": "94a27c1f88ea1142b17a8bd3fdcf1a49ed20f2315a91204de08ec35db67dabf8",
      "executable": false
    },
    "locales/da.pak": {
      "bytes": 642710,
      "sha256": "ac4c51df2b1c15c770b221d28286a780d4dc677d8b25858bb184fb963c63389b",
      "executable": false
    },
    "locales/de.pak": {
      "bytes": 689884,
      "sha256": "94b72d316e5eed1a40c650500c57ab674b65582f74c7402a8252c3a499e6534d",
      "executable": false
    },
    "locales/el.pak": {
      "bytes": 1244672,
      "sha256": "cb9e807eacab0acadef760fd907a88d1e742a2e0a0fa36bb0e4c6f3cae326d1c",
      "executable": false
    },
    "locales/en-GB.pak": {
      "bytes": 556455,
      "sha256": "1e5d3988a17576cf78796985cac19f5ef0690ee03e285b220b251744cb7004bd",
      "executable": false
    },
    "locales/en-US.pak": {
      "bytes": 562522,
      "sha256": "e78f314cd0558023a57be0817a39fb8a45c3bfb467f74da3ccff206e2792af3b",
      "executable": false
    },
    "locales/es-419.pak": {
      "bytes": 680096,
      "sha256": "5728d15f0e18c0b595e934d78551a0c1c82e8fd077c5565f8550ee7fd38c3135",
      "executable": false
    },
    "locales/es.pak": {
      "bytes": 675933,
      "sha256": "6ff87ff53a698c685827d4a11717cfb1c72ef2b3675c02d6de00e19c9d1e2327",
      "executable": false
    },
    "locales/et.pak": {
      "bytes": 617332,
      "sha256": "965db6d716d5e49677ca7be88edf2aa94828c8e26e4a0c63a0ab04b5794f4533",
      "executable": false
    },
    "locales/fa.pak": {
      "bytes": 1022873,
      "sha256": "7de3b5bac7d9460478d3f6d5907eb5fc28e6998e78585cf9949a16ab62b44760",
      "executable": false
    },
    "locales/fi.pak": {
      "bytes": 628663,
      "sha256": "94992bfc0721c2019390f78bbbf4c10f965aabce69926368e86a9367b473f675",
      "executable": false
    },
    "locales/fil.pak": {
      "bytes": 712867,
      "sha256": "2b1fe98a2de34a9941906c9395e727021255586d516938de1a849451a9bdae59",
      "executable": false
    },
    "locales/fr.pak": {
      "bytes": 735063,
      "sha256": "3b20c41ae5ceebe0db881955536fd6489e3687206d047af962a1bb3df2ab8f87",
      "executable": false
    },
    "locales/gu.pak": {
      "bytes": 1439189,
      "sha256": "2e57b916809f2dd112a13b8a74e5d5ff20d28bc5659c71cccb0617413abae2e2",
      "executable": false
    },
    "locales/he.pak": {
      "bytes": 896278,
      "sha256": "dfc9655be276bbefc9ebfb5321fa3a240dad92a722be212ef889b20787ef57e9",
      "executable": false
    },
    "locales/hi.pak": {
      "bytes": 1525504,
      "sha256": "5ced47c0555770f74ca09afbcfbc858c6eb2782ba89d7e2976859c5d0b7bf365",
      "executable": false
    },
    "locales/hr.pak": {
      "bytes": 688516,
      "sha256": "dfd49fefcdd209eaef7db712e7695136c6d89159c9a3bc1734b5f42d19237dbe",
      "executable": false
    },
    "locales/hu.pak": {
      "bytes": 735919,
      "sha256": "3335f362071782d8b49ae2f6d027bfd094a2f48e7a33abe316edb6ea1b20d8bb",
      "executable": false
    },
    "locales/id.pak": {
      "bytes": 608749,
      "sha256": "d0069733f5f2774d103563188c8fc19ee90bac7f0fc369bed2a4917f7fe5936e",
      "executable": false
    },
    "locales/it.pak": {
      "bytes": 665095,
      "sha256": "9e64932b302271e63f3acae221c2954bdf56a5ce5f6afdc173c6d6a9ecb06133",
      "executable": false
    },
    "locales/ja.pak": {
      "bytes": 810386,
      "sha256": "b8fb5aebab14299817094d017effc0c98d4553c0f7177fdb8c525d280e4af925",
      "executable": false
    },
    "locales/kn.pak": {
      "bytes": 1654167,
      "sha256": "efb0f8d63f36ba990f5c91d3cc660bb4bd9ac4ed2fc063eeba382e6068f1e9fa",
      "executable": false
    },
    "locales/ko.pak": {
      "bytes": 690087,
      "sha256": "1647c16a82ba08cce993f09e8162c92494907ab29a20006c6280e2c1990f1e47",
      "executable": false
    },
    "locales/lt.pak": {
      "bytes": 749345,
      "sha256": "690f33e208394d9d076cb1680bd86eb47be17b361480395c2d0bc550bedfb47c",
      "executable": false
    },
    "locales/lv.pak": {
      "bytes": 745705,
      "sha256": "c17e2bd6dbaa15992aae63020e7924ed90457776ecf656ee89bb9c3b39ce20f3",
      "executable": false
    },
    "locales/ml.pak": {
      "bytes": 1700486,
      "sha256": "c8e71960d2227bf8b70ce0783f1ace926f6c76199528cae5e923ba2be7b6b116",
      "executable": false
    },
    "locales/mr.pak": {
      "bytes": 1408607,
      "sha256": "e562b2c29c1e717d70245067b55efb7c8c9a4abf3ce41ffe50a946da3f8bc39a",
      "executable": false
    },
    "locales/ms.pak": {
      "bytes": 641127,
      "sha256": "5fda925ca1683c621c3437b237fd473bba3fa61f538b45023d7356102b501d39",
      "executable": false
    },
    "locales/nb.pak": {
      "bytes": 613129,
      "sha256": "f28129283ea6e60885582054465e883b006a5ca7b2ce2b8714ee35df3e32f03e",
      "executable": false
    },
    "locales/nl.pak": {
      "bytes": 639259,
      "sha256": "8c7964520b17f5114721a9a17705af39f43b562878f7c099bad4d3d7aad0ebaf",
      "executable": false
    },
    "locales/pl.pak": {
      "bytes": 714360,
      "sha256": "cc1c43e5a73a2b94a44b7730ae137203eae40d8834f7d1f3f4b051612be6d6f2",
      "executable": false
    },
    "locales/pt-BR.pak": {
      "bytes": 669990,
      "sha256": "2ae6ec7845e5a0b48520229dfacba4592ee9b40f858f0f371ac89d7d00b99aca",
      "executable": false
    },
    "locales/pt-PT.pak": {
      "bytes": 673490,
      "sha256": "600ef2be3f0732bebdedc043b7f0013c7a3083fd74370e7c0d5db70d5e43f13a",
      "executable": false
    },
    "locales/ro.pak": {
      "bytes": 699060,
      "sha256": "fe7581fe3e1d6d141a009e1d84edeaac96167c8cf726cfa0c090413c9b663c44",
      "executable": false
    },
    "locales/ru.pak": {
      "bytes": 1161393,
      "sha256": "dd8b2ab7f7e0b88cd275211d177ca871c82d3b6fe8a2fc95d3d5b2901daf8043",
      "executable": false
    },
    "locales/sk.pak": {
      "bytes": 727243,
      "sha256": "9c22df72dbe164bac7d4b5628ae1b9d6a475394edc9a1da6bd18512807c37f00",
      "executable": false
    },
    "locales/sl.pak": {
      "bytes": 696472,
      "sha256": "60e0784aa109d0ada6919d6c1f7512054da7da64bf17413d24f89baca60bdeb3",
      "executable": false
    },
    "locales/sr.pak": {
      "bytes": 1071768,
      "sha256": "6a2a7d944aab789166adba932798af18dfee5f8166b4a72e2b1281f57f9d6dc8",
      "executable": false
    },
    "locales/sv.pak": {
      "bytes": 620740,
      "sha256": "3d4c7707f1cc344c6f62c2e48e4e5a8ddb7451d9d33dd4a4d016df2cbc37d7e9",
      "executable": false
    },
    "locales/sw.pak": {
      "bytes": 656958,
      "sha256": "2650bf9c5da36101823e6eb2b31e42baa16c12a4ec045bcc6a1e244ea5e08d50",
      "executable": false
    },
    "locales/ta.pak": {
      "bytes": 1694289,
      "sha256": "dbe797cc56833cda1a261b08669ddfec90b66f2b98f4af01fe35eb9f085d2b4a",
      "executable": false
    },
    "locales/te.pak": {
      "bytes": 1565775,
      "sha256": "100db06558014e6502f25225811c16b34c1de68368aa47d551489e4329ea2832",
      "executable": false
    },
    "locales/th.pak": {
      "bytes": 1315834,
      "sha256": "ce7bc4a5edc0d55a4e9eec78eba2a1adf616d4c9abbc15dd0a718890cb093e50",
      "executable": false
    },
    "locales/tr.pak": {
      "bytes": 668877,
      "sha256": "e91d5ca9e5ff0003b2e28032b10c24756e4380d18b7d6da2a28f86a0d6ca613c",
      "executable": false
    },
    "locales/uk.pak": {
      "bytes": 1168734,
      "sha256": "81458c172681239930dcf5e7869d3eaea4a2a7522bcd1b02b41e3ae8ed756e8f",
      "executable": false
    },
    "locales/ur.pak": {
      "bytes": 1005279,
      "sha256": "5f391f83a804da4007a2f99c42da60eade0d0c3e83ae18fe2780f298a0966b53",
      "executable": false
    },
    "locales/vi.pak": {
      "bytes": 795664,
      "sha256": "1d052ba45578c2a1a7231b57c7b0d8700004a5cecbce6848df271c9e17fff6e5",
      "executable": false
    },
    "locales/zh-CN.pak": {
      "bytes": 569348,
      "sha256": "7b4802fa0578d9147b2b8693e8565746ab3eb221b405f2ead240c5c209af271d",
      "executable": false
    },
    "locales/zh-TW.pak": {
      "bytes": 561500,
      "sha256": "b3ee5958737d20160795080f3ce9048277d918218e62d0d25ce07fc33e0c9e2a",
      "executable": false
    },
    "resources/app.asar": {
      "bytes": 41154494,
      "sha256": "b8942a6676bf376de9467c5a58917e6646c6e67df5226e41c0ba95609790ba1c",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/cursor-proclist/build/Release/cursor_proclist.node": {
      "bytes": 148344,
      "sha256": "f041942a5258687de6a356ece26f6d76dc64f108c22008bf9fa84b1163cba126",
      "executable": true
    },
    "resources/app.asar.unpacked/dist/deps/cursor-proclist/index.js": {
      "bytes": 935,
      "sha256": "1779996780a0e165ea570c3e90ffdae3cff7e2e91f11252a7887d1740893eddd",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/cursor-proclist/package.json": {
      "bytes": 294,
      "sha256": "569c892ee81c002b293a6342c32694c4723f30661dddc861f3a49453e392eb56",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/cursor-proclist/rebuild-with-lock.js": {
      "bytes": 11845,
      "sha256": "e1217d6b0e3e4b3e99d0060a5b97ae324c23d331b0d138d77bbc45f150163b2f",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/node-addon-api/index.js": {
      "bytes": 435,
      "sha256": "afbfa96b5c40c643828f212610129d2911095eff1e86e63ccfe81658d6fe61d9",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/node-addon-api/package-support.json": {
      "bytes": 467,
      "sha256": "b1cb7da23cca1681c7392a3c889eb0cc4916c53d2d7692d4b654ae751f3442f3",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/node-addon-api/package.json": {
      "bytes": 11005,
      "sha256": "19d23a454d2fb2ad84717a72a5d65a88511e433a8f94740dfd9e9c93ecced5e8",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/node-gyp-build/bin.js": {
      "bytes": 2094,
      "sha256": "dc022adc093b9b79e1a0ef4b6bc3e6a52e3d627102113dad4afacbbe81f13a26",
      "executable": true
    },
    "resources/app.asar.unpacked/dist/deps/node-gyp-build/build-test.js": {
      "bytes": 398,
      "sha256": "34c19ff8b6675d6d27c63a7df44d77a442805eeea8756d1c89e0264f4a3028f6",
      "executable": true
    },
    "resources/app.asar.unpacked/dist/deps/node-gyp-build/index.js": {
      "bytes": 390,
      "sha256": "a7ed0d5ae218a19bdbdf15a590d0893790ddf536313b66a787554693cfaae078",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/node-gyp-build/node-gyp-build.js": {
      "bytes": 6078,
      "sha256": "134f0585f7c665db89f332a379158c6f113274422e42aaf54e0aa9d5ac37f577",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/node-gyp-build/optional.js": {
      "bytes": 143,
      "sha256": "e0b3a3a04166e6ecf1020cb31c0c4a54432c16d6d88714bd4de2214cf67dec81",
      "executable": true
    },
    "resources/app.asar.unpacked/dist/deps/node-gyp-build/package.json": {
      "bytes": 1004,
      "sha256": "9e8def3fbf123e28aa1ca4b6aa557fba4e66eecf6e86d170b61ec1c7ed51305d",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/runtime-deps-manifest.json": {
      "bytes": 639,
      "sha256": "217aa0897fea7a6692b36f5cdad368a2e11e0b4a8a782c7455808c1a11f184d1",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/sand-notification-settings/build/Release/sand_notification_settings.node": {
      "bytes": 18848,
      "sha256": "6d279475610137da20f49df28a142b9158d34ed69085e38a346dd0ec1b8ed5a1",
      "executable": true
    },
    "resources/app.asar.unpacked/dist/deps/sand-notification-settings/index.js": {
      "bytes": 368,
      "sha256": "9eb6a6109739a3116732b38650109f66b7d9a01c265c456f4b02db686247dc96",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/sand-notification-settings/package.json": {
      "bytes": 320,
      "sha256": "2807bb28b29dc4eae8b37e75aae0b2381b49a842d97e689b86a3944b96d31517",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/tree-sitter/build/Release/tree_sitter_runtime_binding.node": {
      "bytes": 678240,
      "sha256": "778550230e0c3d87c0afadc9ede23c97d014f6e6d548bb4be91b234c394a3ceb",
      "executable": true
    },
    "resources/app.asar.unpacked/dist/deps/tree-sitter/index.js": {
      "bytes": 25716,
      "sha256": "ba5e8461e5068f2b58ea860aea331ed0c6d8a25f21142d75a6145a1544fc9ffe",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/tree-sitter/package.json": {
      "bytes": 1757,
      "sha256": "8cca5044dd3381dbf958dea36ef6d9f81f379886d32ef845919cf07679c6e42c",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/tree-sitter-bash/bindings/node/index.js": {
      "bytes": 201,
      "sha256": "609bdf22b8fd183025b3c24e8587f6211d50358e8f2e4c526b9217349ed9dbc0",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/tree-sitter-bash/package.json": {
      "bytes": 1616,
      "sha256": "ee9d6515031266905123792f891fc9c3db75f55c5d9c1e027a315a60a09557c4",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/tree-sitter-bash/prebuilds/linux-x64/tree-sitter-bash.node": {
      "bytes": 1383184,
      "sha256": "5b313fbec62ec84f0202a75fa3b09319d802cad661753a2522975d1f2f852b7f",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/web-tree-sitter/package.json": {
      "bytes": 886,
      "sha256": "52f0012fb1a4e6a2f23037f2dd147ab72d8401732c4bbaa232d590bd93d2ac8d",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/web-tree-sitter/tree-sitter.js": {
      "bytes": 75606,
      "sha256": "3499392cf0207a6dcca0567ada202ba6f0fdcd0b8c0f1f16e038d48df0c20b62",
      "executable": false
    },
    "resources/app.asar.unpacked/dist/deps/web-tree-sitter/tree-sitter.wasm": {
      "bytes": 185642,
      "sha256": "015b7a64b9150de7eb814e295d3a8eade58e80acd5655f45ab6765b189c1422e",
      "executable": true
    },
    "resources/app.asar.unpacked/dist/electron-main/onepassword-connection-service.cjs": {
      "bytes": 106838,
      "sha256": "7392f645ce0d14570c714517592c2395d2f2fe8d8c0b5d1a14341f2b2a0ec1ca",
      "executable": false
    },
    "resources/apparmor-profile": {
      "bytes": 229,
      "sha256": "da7453d6a1d689e69a85cdb78ce390ce6b57f1e105598c1ef3e48cda2acf68d6",
      "executable": false
    },
    "resources/icon.png": {
      "bytes": 152146,
      "sha256": "3f177f014c21cc7517a261f06e8654c120d362ce1a7a7d826801e8a30a23c5cf",
      "executable": false
    },
    "resources.pak": {
      "bytes": 7055888,
      "sha256": "456f377e4536ee74fdea32b116f76fc854009dd880a91b9063a151ff28f91f61",
      "executable": false
    },
    "snapshot_blob.bin": {
      "bytes": 346432,
      "sha256": "89b5f5ad39f6dc3adce8a99ed0fba350e587c87574166b704c43af4241d6c1b3",
      "executable": false
    },
    "v8_context_snapshot.bin": {
      "bytes": 721176,
      "sha256": "fa4ec25a66cbe8e79a9c7d00820a594a437edc5f6e11b0862660c45a0de633cf",
      "executable": false
    },
    "vk_swiftshader_icd.json": {
      "bytes": 107,
      "sha256": "c9eef28b6b984fec220ef0abfecc40b502d46946706e47bfe97707027cb818bd",
      "executable": false
    }
  }
} as const;
for(const file of Object.values(WINDOWS_GROK_DESKTOP.files))Object.freeze(file);
Object.freeze(WINDOWS_GROK_DESKTOP.files);Object.freeze(WINDOWS_GROK_DESKTOP);
export function windowsDesktopAsset(id:DesktopAppId):WindowsDesktopAsset{
 if(id==='grok-bot')return WINDOWS_GROK_DESKTOP;
 if(id==='claude-desktop')return WINDOWS_CLAUDE_DESKTOP;
 throw new AppError('此桌面客户端的 AMD64 组件尚未完成核验',409,'DESKTOP_COMPONENT_UNAVAILABLE');
}
