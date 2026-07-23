// src/catalog.js — with clear Android / PC row names
// All SKUs run from 1 to 125.

export const CATALOG = {
  // ---- APK MC PANEL FF ROOT ANDROID (pid 124) ----
  sku_1: { pid: '124', row: 'APK MC PANEL', name: 'APK MC PANEL 1 DAY', duration: '1 DaYs', price: 130, image: 'https://via.placeholder.com/300', external: true },
  sku_2: { pid: '124', row: 'APK MC PANEL', name: 'APK MC PANEL 3 DAY', duration: '3 DaYs', price: 240, image: 'https://via.placeholder.com/300', external: true },
  sku_3: { pid: '124', row: 'APK MC PANEL', name: 'APK MC PANEL 7 DAY', duration: '7 DaYs', price: 450, image: 'https://via.placeholder.com/300', external: true },
  sku_4: { pid: '124', row: 'APK MC PANEL', name: 'APK MC PANEL 15 DAY', duration: '15 DaYs', price: 650, image: 'https://via.placeholder.com/300', external: true },
  sku_5: { pid: '124', row: 'APK MC PANEL', name: 'APK MC PANEL 30 DAY', duration: '30 DaYs', price: 850, image: 'https://via.placeholder.com/300', external: true },

  // ---- BR ANDROID (pid 67) ----
  sku_6: { pid: '67', row: 'BR ANDROID', name: 'BR ROOT 1 DAY', duration: '1 DaYs', price: 150, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_7: { pid: '67', row: 'BR ANDROID', name: 'BR ROOT 7 DAY', duration: '7 DaYs', price: 450, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_8: { pid: '67', row: 'BR ANDROID', name: 'BR ROOT 15 DAY', duration: '15 DaYs', price: 750, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_9: { pid: '67', row: 'BR ANDROID', name: 'BR ROOT 30 DAY', duration: '30 DaYs', price: 1250, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },

  // ---- BR PC (pid 49) ----
  sku_10: { pid: '49', row: 'BR PC', name: 'BR PC AIM SILENT 1 DAY', duration: '1 Day Pc Aim Silent', price: 180, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_11: { pid: '49', row: 'BR PC', name: 'BR PC BYPASS 1 DAY', duration: '1 Day Pc Bypass + Silent', price: 250, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_12: { pid: '49', row: 'BR PC', name: 'BR PC MODMENU 1 DAY', duration: '1 Day Pc Modmenu x86', price: 200, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_13: { pid: '49', row: 'BR PC', name: 'BR PC AIM SILENT 10 DAY', duration: '10 Days Pc Aim Silent', price: 650, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_14: { pid: '49', row: 'BR PC', name: 'BR PC BYPASS 10 DAY', duration: '10 Days Pc Bypass + Silent', price: 750, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_15: { pid: '49', row: 'BR PC', name: 'BR PC MODMENU 10 DAY', duration: '10 Day Pc Modmenu x86', price: 650, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_16: { pid: '49', row: 'BR PC', name: 'BR PC AIM SILENT 30 DAY', duration: '30 Days Pc Aim Silent', price: 1250, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_17: { pid: '49', row: 'BR PC', name: 'BR PC BYPASS 30 DAY', duration: '30 Days Pc Bypass + Silent', price: 1450, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },
  sku_18: { pid: '49', row: 'BR PC', name: 'BR PC MODMENU 30 DAY', duration: '30 Day Pc Modmenu x86', price: 1350, image: 'https://i.postimg.cc/65Fdfcgp/Screenshot-20260425-150006.jpg', external: true },

  // ---- DRIP ANDROID (combines Nonroot, 8BP, Root, Proxy) ----
  sku_19: { pid: '59', row: 'DRIP ANDROID', name: 'DRIP 8BP 1 DAY', duration: '1 DaYs', price: 120, image: 'https://via.placeholder.com/300', external: true },
  sku_20: { pid: '59', row: 'DRIP ANDROID', name: 'DRIP 8BP 7 DAY', duration: '7 DaYs', price: 220, image: 'https://via.placeholder.com/300', external: true },
  sku_21: { pid: '59', row: 'DRIP ANDROID', name: 'DRIP 8BP 30 DAY', duration: '30 DaYs', price: 850, image: 'https://via.placeholder.com/300', external: true },

  sku_22: { pid: '62', row: 'DRIP ANDROID', name: 'DRIP NONROOT 1 DAY', duration: '1 DaYS NONROOT', price: 120, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },
  sku_23: { pid: '62', row: 'DRIP ANDROID', name: 'DRIP NONROOT 3 DAY', duration: '3 DaYS NONROOT', price: 220, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },
  sku_24: { pid: '62', row: 'DRIP ANDROID', name: 'DRIP NONROOT 7 DAY', duration: '7 DaYS NONROOT', price: 450, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },
  sku_25: { pid: '62', row: 'DRIP ANDROID', name: 'DRIP NONROOT 15 DAY', duration: '15 DaYS NONROOT', price: 650, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },
  sku_26: { pid: '62', row: 'DRIP ANDROID', name: 'DRIP NONROOT 30 DAY', duration: '30 DaYS NONROOT', price: 920, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },

  sku_27: { pid: '63', row: 'DRIP ANDROID', name: 'DRIP ROOT 30 DAY', duration: '30 DaYS ROOT', price: 1080, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },

  sku_28: { pid: '91', row: 'DRIP ANDROID', name: 'DRIP PROXY 3 DAY', duration: '3 DaYs', price: 220, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },
  sku_29: { pid: '91', row: 'DRIP ANDROID', name: 'DRIP PROXY 7 DAY', duration: '7 DaYs', price: 450, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },
  sku_30: { pid: '91', row: 'DRIP ANDROID', name: 'DRIP PROXY 30 DAY', duration: '30 DaYs', price: 920, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },

  // ---- DRIP PC (pid 44) ----
  sku_31: { pid: '44', row: 'DRIP PC', name: 'DRIP PC 1 DAY', duration: '1 DaYS PC AIMKILL', price: 200, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },
  sku_32: { pid: '44', row: 'DRIP PC', name: 'DRIP PC 7 DAY', duration: '7 DaYS PC AIMKILL', price: 650, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },
  sku_33: { pid: '44', row: 'DRIP PC', name: 'DRIP PC 15 DAY', duration: '15 DaYS PC AIMKILL', price: 900, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },
  sku_34: { pid: '44', row: 'DRIP PC', name: 'DRIP PC 30 DAY', duration: '30 DaYS PC AIMKILL', price: 1450, image: 'https://i.postimg.cc/Jnwh1T2q/Screenshot-20260421-102516.jpg', external: true },

  // ---- FLUORITE IOS FF (pid 58) ----
  sku_35: { pid: '58', row: 'FLUORITE IOS FF', name: 'FLUORITE FF 1 DAY', duration: '1 DAYs FluoRite FF', price: 550, image: 'https://i.postimg.cc/R07kHX0k/fluorite-ios-ff-og-1765886845.webp', external: true },
  sku_36: { pid: '58', row: 'FLUORITE IOS FF', name: 'FLUORITE FF 7 DAY', duration: '7 DAYs FluoRite FF', price: 1550, image: 'https://i.postimg.cc/R07kHX0k/fluorite-ios-ff-og-1765886845.webp', external: true },
  sku_37: { pid: '58', row: 'FLUORITE IOS FF', name: 'FLUORITE FF 30 DAY', duration: '30 DAYs FluoRite FF', price: 3200, image: 'https://i.postimg.cc/R07kHX0k/fluorite-ios-ff-og-1765886845.webp', external: true },

  // ---- FLUORITE IOS MLBB (pid 84) ----
  sku_38: { pid: '84', row: 'FLUORITE IOS MLBB', name: 'FLUORITE MLBB 1 DAY', duration: '1 DaYs', price: 450, image: 'https://via.placeholder.com/300', external: true },
  sku_39: { pid: '84', row: 'FLUORITE IOS MLBB', name: 'FLUORITE MLBB 7 DAY', duration: '7 DaYs', price: 1500, image: 'https://via.placeholder.com/300', external: true },
  sku_40: { pid: '84', row: 'FLUORITE IOS MLBB', name: 'FLUORITE MLBB 30 DAY', duration: '30 DaYs', price: 2800, image: 'https://via.placeholder.com/300', external: true },

  // ---- HAXX-CKER PRO FF ROOT ANDROID (pid 64) ----
  sku_41: { pid: '64', row: 'HAXX-CKER PRO', name: 'HAXX-CKER 10 DAY', duration: '10 DaYs', price: 840, image: 'https://i.postimg.cc/HLxmsSCy/Screenshot-20260425-150832.jpg', external: true },
  sku_42: { pid: '64', row: 'HAXX-CKER PRO', name: 'HAXX-CKER 20 DAY', duration: '20 DaYs', price: 1600, image: 'https://i.postimg.cc/HLxmsSCy/Screenshot-20260425-150832.jpg', external: true },

  // ---- HG CHEATS ANDROID PROXY FF NONROOT (pid 123) ----
  sku_43: { pid: '123', row: 'HG PROXY', name: 'HG PROXY 1 DAY', duration: '1 DaYs', price: 130, image: 'https://i.postimg.cc/fRGsXVfy/Screenshot-20260421-102611.jpg', external: true },
  sku_44: { pid: '123', row: 'HG PROXY', name: 'HG PROXY 7 DAY', duration: '7 DaYs', price: 350, image: 'https://i.postimg.cc/fRGsXVfy/Screenshot-20260421-102611.jpg', external: true },
  sku_45: { pid: '123', row: 'HG PROXY', name: 'HG PROXY 10 DAY', duration: '10 DaYs', price: 450, image: 'https://i.postimg.cc/fRGsXVfy/Screenshot-20260421-102611.jpg', external: true },
  sku_46: { pid: '123', row: 'HG PROXY', name: 'HG PROXY 30 DAY', duration: '30 DaYs', price: 750, image: 'https://i.postimg.cc/fRGsXVfy/Screenshot-20260421-102611.jpg', external: true },

  // ---- HG CHEATS FF APKMOD NONROOT+ROOT (pid 65) ----
  sku_47: { pid: '65', row: 'HG APKMOD', name: 'HG APKMOD 1 DAY', duration: '1 DaYs Root + Nonroot', price: 130, image: 'https://i.postimg.cc/fRGsXVfy/Screenshot-20260421-102611.jpg', external: true },
  sku_48: { pid: '65', row: 'HG APKMOD', name: 'HG APKMOD 7 DAY', duration: '7 DaYs Root+Nonroot', price: 350, image: 'https://i.postimg.cc/fRGsXVfy/Screenshot-20260421-102611.jpg', external: true },
  sku_49: { pid: '65', row: 'HG APKMOD', name: 'HG APKMOD 10 DAY', duration: '10 DaYs Root+Nonroot', price: 450, image: 'https://i.postimg.cc/fRGsXVfy/Screenshot-20260421-102611.jpg', external: true },
  sku_50: { pid: '65', row: 'HG APKMOD', name: 'HG APKMOD 30 DAY', duration: '30 DaYs Root+Nonroot', price: 750, image: 'https://i.postimg.cc/fRGsXVfy/Screenshot-20260421-102611.jpg', external: true },

  // ---- HIKARI MOD FF ROOT ANDROID (pid 72) ----
  sku_51: { pid: '72', row: 'HIKARI MOD', name: 'HIKARI 1 DAY', duration: '1 Days', price: 120, image: 'https://i.postimg.cc/k5kH3wM4/Screenshot-20260605-083930.jpg', external: true },
  sku_52: { pid: '72', row: 'HIKARI MOD', name: 'HIKARI 3 DAY', duration: '3 Days', price: 200, image: 'https://i.postimg.cc/k5kH3wM4/Screenshot-20260605-083930.jpg', external: true },
  sku_53: { pid: '72', row: 'HIKARI MOD', name: 'HIKARI 7 DAY', duration: '7 Days', price: 350, image: 'https://i.postimg.cc/k5kH3wM4/Screenshot-20260605-083930.jpg', external: true },
  sku_54: { pid: '72', row: 'HIKARI MOD', name: 'HIKARI 15 DAY', duration: '15 Days', price: 500, image: 'https://i.postimg.cc/k5kH3wM4/Screenshot-20260605-083930.jpg', external: true },
  sku_55: { pid: '72', row: 'HIKARI MOD', name: 'HIKARI 30 DAY', duration: '30 Days', price: 850, image: 'https://i.postimg.cc/k5kH3wM4/Screenshot-20260605-083930.jpg', external: true },

  // ---- IOS CLOUD CODM (pid 87) ----
  sku_56: { pid: '87', row: 'IOS CLOUD CODM', name: 'CLOUD CODM 30 DAY', duration: '30 DaYs', price: 2800, image: 'https://via.placeholder.com/300', external: true },

  // ---- IOS FLUORITE 8 BALL POOL (pid 86) ----
  sku_57: { pid: '86', row: 'IOS FLUORITE 8BP', name: 'FLUORITE 8BP 1 DAY', duration: '1 DaYs', price: 450, image: 'https://via.placeholder.com/300', external: true },
  sku_58: { pid: '86', row: 'IOS FLUORITE 8BP', name: 'FLUORITE 8BP 7 DAY', duration: '7 DaYs', price: 1500, image: 'https://via.placeholder.com/300', external: true },
  sku_59: { pid: '86', row: 'IOS FLUORITE 8BP', name: 'FLUORITE 8BP 30 DAY', duration: '30 DaYs', price: 2800, image: 'https://via.placeholder.com/300', external: true },

  // ---- IOS IPHONE ALL GBOX CERTIFICATE (pid 85) ----
  sku_60: { pid: '85', row: 'IOS GBOX CERT', name: 'GBOX ESIGN 1 YEAR', duration: '1 Year Ios Esign Gbox Certificate', price: 1000, image: 'https://via.placeholder.com/300', external: true },
  sku_61: { pid: '85', row: 'IOS GBOX CERT', name: 'GBOX SIGNER 1 YEAR', duration: '1 Year Ios Signer Gbox Certificate', price: 2000, image: 'https://via.placeholder.com/300', external: true },

  // ---- KOS 8 BALL POOL NONROOT ANDROID (pid 76) ----
  sku_62: { pid: '76', row: 'KOS 8BP', name: 'KOS 8BP PREMIUM 1 DAY', duration: '1 DaYs Premium Access', price: 220, image: 'https://via.placeholder.com/300', external: true },
  sku_63: { pid: '76', row: 'KOS 8BP', name: 'KOS 8BP MOD 7 DAY', duration: '7 DaYs Mod', price: 550, image: 'https://via.placeholder.com/300', external: true },
  sku_64: { pid: '76', row: 'KOS 8BP', name: 'KOS 8BP PREMIUM 7 DAY', duration: '7 DaYs Premium Access', price: 600, image: 'https://via.placeholder.com/300', external: true },
  sku_65: { pid: '76', row: 'KOS 8BP', name: 'KOS 8BP MOD 30 DAY', duration: '30 DaYs Mod', price: 1500, image: 'https://via.placeholder.com/300', external: true },
  sku_66: { pid: '76', row: 'KOS 8BP', name: 'KOS 8BP PREMIUM 30 DAY', duration: '30 DaYs Premium Access', price: 2200, image: 'https://via.placeholder.com/300', external: true },

  // ---- KOS CARROM POOL NONROOT ANDROID (pid 75) ----
  sku_67: { pid: '75', row: 'KOS CARROM', name: 'KOS CARROM 1 DAY', duration: '1 DaYs', price: 200, image: 'https://via.placeholder.com/300', external: true },
  sku_68: { pid: '75', row: 'KOS CARROM', name: 'KOS CARROM 7 DAY', duration: '7 DaYs', price: 450, image: 'https://via.placeholder.com/300', external: true },
  sku_69: { pid: '75', row: 'KOS CARROM', name: 'KOS CARROM 30 DAY', duration: '30 DaYs', price: 1450, image: 'https://via.placeholder.com/300', external: true },

  // ---- KOS FF ROOT ANDROID (pid 74) ----
  sku_70: { pid: '74', row: 'KOS ROOT', name: 'KOS ROOT 1 DAY', duration: '1 DaYs', price: 160, image: 'https://i.postimg.cc/R098B4HF/file-0000000031fc720886d5eb5b766c5d0b.png', external: true },
  sku_71: { pid: '74', row: 'KOS ROOT', name: 'KOS ROOT 7 DAY', duration: '7 DaYs', price: 550, image: 'https://i.postimg.cc/R098B4HF/file-0000000031fc720886d5eb5b766c5d0b.png', external: true },
  sku_72: { pid: '74', row: 'KOS ROOT', name: 'KOS ROOT 30 DAY', duration: '30 DaYs', price: 1550, image: 'https://i.postimg.cc/R098B4HF/file-0000000031fc720886d5eb5b766c5d0b.png', external: true },

  // ---- MIGUL IPHONE IOS FF (pid 69) ----
  sku_73: { pid: '69', row: 'MIGUL IOS', name: 'MIGUL BASIC 1 DAY', duration: '1 DaYs Basic', price: 400, image: 'https://i.postimg.cc/MHhPrSwQ/file-00000000b7bc7208b6362b0658f64e7e.png', external: true },
  sku_74: { pid: '69', row: 'MIGUL IOS', name: 'MIGUL PRO 1 DAY', duration: '1 DaYs PRO', price: 550, image: 'https://i.postimg.cc/MHhPrSwQ/file-00000000b7bc7208b6362b0658f64e7e.png', external: true },
  sku_75: { pid: '69', row: 'MIGUL IOS', name: 'MIGUL BASIC 7 DAY', duration: '7 DaYs Basic', price: 900, image: 'https://i.postimg.cc/MHhPrSwQ/file-00000000b7bc7208b6362b0658f64e7e.png', external: true },
  sku_76: { pid: '69', row: 'MIGUL IOS', name: 'MIGUL PRO 7 DAY', duration: '7 DaYs PRO', price: 1550, image: 'https://i.postimg.cc/MHhPrSwQ/file-00000000b7bc7208b6362b0658f64e7e.png', external: true },
  sku_77: { pid: '69', row: 'MIGUL IOS', name: 'MIGUL BASIC 30 DAY', duration: '30 DaYs Basic', price: 1800, image: 'https://i.postimg.cc/MHhPrSwQ/file-00000000b7bc7208b6362b0658f64e7e.png', external: true },
  sku_78: { pid: '69', row: 'MIGUL IOS', name: 'MIGUL PRO 30 DAY', duration: '30 DaYs PRO', price: 3200, image: 'https://i.postimg.cc/MHhPrSwQ/file-00000000b7bc7208b6362b0658f64e7e.png', external: true },

  // ---- NEO STRIKE FF ROOT ANDROID (pid 70) ----
  sku_79: { pid: '70', row: 'NEO STRIKE', name: 'NEO STRIKE 1 DAY', duration: '1 DaYs', price: 120, image: 'https://i.postimg.cc/fbjGtJN9/file-00000000f5b47208b97547f7d5746409.png', external: true },
  sku_80: { pid: '70', row: 'NEO STRIKE', name: 'NEO STRIKE 3 DAY', duration: '3 DaYs', price: 300, image: 'https://i.postimg.cc/fbjGtJN9/file-00000000f5b47208b97547f7d5746409.png', external: true },
  sku_81: { pid: '70', row: 'NEO STRIKE', name: 'NEO STRIKE 7 DAY', duration: '7 DaYs', price: 500, image: 'https://i.postimg.cc/fbjGtJN9/file-00000000f5b47208b97547f7d5746409.png', external: true },
  sku_82: { pid: '70', row: 'NEO STRIKE', name: 'NEO STRIKE 14 DAY', duration: '14 DaYs', price: 650, image: 'https://i.postimg.cc/fbjGtJN9/file-00000000f5b47208b97547f7d5746409.png', external: true },
  sku_83: { pid: '70', row: 'NEO STRIKE', name: 'NEO STRIKE 28 DAY', duration: '28 DaYs', price: 850, image: 'https://i.postimg.cc/fbjGtJN9/file-00000000f5b47208b97547f7d5746409.png', external: true },

  // ---- PATO TEAM FF ALL ANDROID (pid 54) ----
  sku_84: { pid: '54', row: 'PATO TEAM', name: 'PATO MIX 3 DAY', duration: '3 DaYs All Colours Mix', price: 550, image: 'https://i.postimg.cc/RV2ypjJM/Screenshot-20260421-102813.jpg', external: true },
  sku_85: { pid: '54', row: 'PATO TEAM', name: 'PATO MIX 7 DAY', duration: '7 DaYs All Colours Mix', price: 850, image: 'https://i.postimg.cc/RV2ypjJM/Screenshot-20260421-102813.jpg', external: true },
  sku_86: { pid: '54', row: 'PATO TEAM', name: 'PATO MIX 15 DAY', duration: '15 DaYs All Colours Mix', price: 1250, image: 'https://i.postimg.cc/RV2ypjJM/Screenshot-20260421-102813.jpg', external: true },
  sku_87: { pid: '54', row: 'PATO TEAM', name: 'PATO MIX 30 DAY', duration: '30 DaYs All Colours Mix', price: 1550, image: 'https://i.postimg.cc/RV2ypjJM/Screenshot-20260421-102813.jpg', external: true },

  // ---- PRIME HOOK FF NONROOT ANDROID (pid 48) ----
  sku_88: { pid: '48', row: 'PRIME HOOK', name: 'PRIME 1 DAY', duration: '1 Days Nonroot', price: 100, image: 'https://i.postimg.cc/x8ChBQPd/IMG-20260421-102934-585.jpg', external: true },
  sku_89: { pid: '48', row: 'PRIME HOOK', name: 'PRIME 3 DAY', duration: '3 Days Nonroot', price: 160, image: 'https://i.postimg.cc/x8ChBQPd/IMG-20260421-102934-585.jpg', external: true },
  sku_90: { pid: '48', row: 'PRIME HOOK', name: 'PRIME 7 DAY', duration: '7 Days NonRoot', price: 300, image: 'https://i.postimg.cc/x8ChBQPd/IMG-20260421-102934-585.jpg', external: true },
  sku_91: { pid: '48', row: 'PRIME HOOK', name: 'PRIME 10 DAY', duration: '10 Days Nonroot', price: 500, image: 'https://i.postimg.cc/x8ChBQPd/IMG-20260421-102934-585.jpg', external: true },

  // ---- RAPID CORE FF ROOT ANDROID (pid 130) ----
  sku_92: { pid: '130', row: 'RAPID CORE', name: 'RAPID 1 DAY', duration: '1 DaYs', price: 120, image: 'https://via.placeholder.com/300', external: true },
  sku_93: { pid: '130', row: 'RAPID CORE', name: 'RAPID 7 DAY', duration: '7 DaYs', price: 350, image: 'https://via.placeholder.com/300', external: true },
  sku_94: { pid: '130', row: 'RAPID CORE', name: 'RAPID 14 DAY', duration: '14 DaYs', price: 650, image: 'https://via.placeholder.com/300', external: true },
  sku_95: { pid: '130', row: 'RAPID CORE', name: 'RAPID 30 DAY', duration: '30 DaYs', price: 1000, image: 'https://via.placeholder.com/300', external: true },

  // ---- REAPER X PRO FF ROOT ANDROID (pid 81) ----
  sku_96: { pid: '81', row: 'REAPER X PRO', name: 'REAPER X 10 DAY', duration: '10 DaYs', price: 350, image: 'https://via.placeholder.com/300', external: true },

  // ---- SILENT CHEAT FF NONROOT APKMOD (pid 127) ----
  sku_97: { pid: '127', row: 'SILENT NONROOT', name: 'SILENT NONROOT 1 DAY', duration: '1 DaYs', price: 100, image: 'https://via.placeholder.com/300', external: true },
  sku_98: { pid: '127', row: 'SILENT NONROOT', name: 'SILENT NONROOT 3 DAY', duration: '3 DaYs', price: 160, image: 'https://via.placeholder.com/300', external: true },
  sku_99: { pid: '127', row: 'SILENT NONROOT', name: 'SILENT NONROOT 7 DAY', duration: '7 DaYs', price: 350, image: 'https://via.placeholder.com/300', external: true },
  sku_100: { pid: '127', row: 'SILENT NONROOT', name: 'SILENT NONROOT 14 DAY', duration: '14 DaYs', price: 650, image: 'https://via.placeholder.com/300', external: true },
  sku_101: { pid: '127', row: 'SILENT NONROOT', name: 'SILENT NONROOT 28 DAY', duration: '28 DaYs', price: 1000, image: 'https://via.placeholder.com/300', external: true },

  // ---- SILENT CHEAT FF ROOT ANDROID (pid 128) ----
  sku_102: { pid: '128', row: 'SILENT ROOT', name: 'SILENT ROOT SAFE 1 DAY', duration: '1 DaYs SAFE', price: 100, image: 'https://via.placeholder.com/300', external: true },
  sku_103: { pid: '128', row: 'SILENT ROOT', name: 'SILENT ROOT BRUTAL 1 DAY', duration: '1 DaYs BRUTAL', price: 110, image: 'https://via.placeholder.com/300', external: true },
  sku_104: { pid: '128', row: 'SILENT ROOT', name: 'SILENT ROOT SAFE 3 DAY', duration: '3 DaYs SAFE', price: 160, image: 'https://via.placeholder.com/300', external: true },
  sku_105: { pid: '128', row: 'SILENT ROOT', name: 'SILENT ROOT BRUTAL 3 DAY', duration: '3 DaYs BRUTAL', price: 180, image: 'https://via.placeholder.com/300', external: true },
  sku_106: { pid: '128', row: 'SILENT ROOT', name: 'SILENT ROOT SAFE 7 DAY', duration: '7 DaYs SAFE', price: 340, image: 'https://via.placeholder.com/300', external: true },
  sku_107: { pid: '128', row: 'SILENT ROOT', name: 'SILENT ROOT BRUTAL 7 DAY', duration: '7 DaYs BRUTAL', price: 380, image: 'https://via.placeholder.com/300', external: true },
  sku_108: { pid: '128', row: 'SILENT ROOT', name: 'SILENT ROOT SAFE 14 DAY', duration: '14 DaYs SAFE', price: 640, image: 'https://via.placeholder.com/300', external: true },
  sku_109: { pid: '128', row: 'SILENT ROOT', name: 'SILENT ROOT BRUTAL 14 DAY', duration: '14 DaYs BRUTAL', price: 680, image: 'https://via.placeholder.com/300', external: true },
  sku_110: { pid: '128', row: 'SILENT ROOT', name: 'SILENT ROOT SAFE 28 DAY', duration: '28 DaYs SAFE', price: 900, image: 'https://via.placeholder.com/300', external: true },
  sku_111: { pid: '128', row: 'SILENT ROOT', name: 'SILENT ROOT BRUTAL 28 DAY', duration: '28 DaYs BRUTAL', price: 1100, image: 'https://via.placeholder.com/300', external: true },

  // ---- SNAKE 8 BALL POOL NONROOT ANDROID (pid 79) ----
  sku_112: { pid: '79', row: 'SNAKE 8BP', name: 'SNAKE 8BP 3 DAY', duration: '3 DaYs', price: 800, image: 'https://via.placeholder.com/300', external: true },
  sku_113: { pid: '79', row: 'SNAKE 8BP', name: 'SNAKE 8BP 10 DAY', duration: '10 DaYs', price: 2000, image: 'https://via.placeholder.com/300', external: true },
  sku_114: { pid: '79', row: 'SNAKE 8BP', name: 'SNAKE 8BP 30 DAY', duration: '30 DaYs', price: 3800, image: 'https://via.placeholder.com/300', external: true },

  // ---- SNAKE CARROM POOL NONROOT ANDROID (pid 77) ----
  sku_115: { pid: '77', row: 'SNAKE CARROM', name: 'SNAKE CARROM 3 DAY', duration: '3 DaYs', price: 280, image: 'https://via.placeholder.com/300', external: true },
  sku_116: { pid: '77', row: 'SNAKE CARROM', name: 'SNAKE CARROM 10 DAY', duration: '10 DaYs', price: 850, image: 'https://via.placeholder.com/300', external: true },
  sku_117: { pid: '77', row: 'SNAKE CARROM', name: 'SNAKE CARROM 30 DAY', duration: '30 DaYs', price: 2000, image: 'https://via.placeholder.com/300', external: true },

  // ---- SNAKE SOCCER STARS NONROOT ANDROID (pid 78) ----
  sku_118: { pid: '78', row: 'SNAKE SOCCER', name: 'SNAKE SOCCER 3 DAY', duration: '3 DaYs', price: 280, image: 'https://via.placeholder.com/300', external: true },
  sku_119: { pid: '78', row: 'SNAKE SOCCER', name: 'SNAKE SOCCER 10 DAY', duration: '10 DaYs', price: 850, image: 'https://via.placeholder.com/300', external: true },
  sku_120: { pid: '78', row: 'SNAKE SOCCER', name: 'SNAKE SOCCER 30 DAY', duration: '30 DaYs', price: 2000, image: 'https://via.placeholder.com/300', external: true },

  // ---- XYZ CHEATS FF ROOT ANDROID (pid 66) ----
  sku_121: { pid: '66', row: 'XYZ CHEATS', name: 'XYZ 1 DAY', duration: '1 Days', price: 120, image: 'https://i.postimg.cc/Y0HwXZkt/IMG-20260430-190421-873.jpg', external: true },
  sku_122: { pid: '66', row: 'XYZ CHEATS', name: 'XYZ 3 DAY', duration: '3 Days', price: 140, image: 'https://i.postimg.cc/Y0HwXZkt/IMG-20260430-190421-873.jpg', external: true },
  sku_123: { pid: '66', row: 'XYZ CHEATS', name: 'XYZ 7 DAY', duration: '7 Days', price: 240, image: 'https://i.postimg.cc/Y0HwXZkt/IMG-20260430-190421-873.jpg', external: true },
  sku_124: { pid: '66', row: 'XYZ CHEATS', name: 'XYZ 15 DAY', duration: '15 Days', price: 450, image: 'https://i.postimg.cc/Y0HwXZkt/IMG-20260430-190421-873.jpg', external: true },
  sku_125: { pid: '66', row: 'XYZ CHEATS', name: 'XYZ 30 DAY', duration: '30 Days', price: 850, image: 'https://i.postimg.cc/Y0HwXZkt/IMG-20260430-190421-873.jpg', external: true },
};

export function catalogFind(sku) {
  return CATALOG[sku] ?? null;
}