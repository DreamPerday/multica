const path = require("node:path");

module.exports = {
  dependencies: {
    "@react-native-community/datetimepicker": {
      root: path.resolve(
        __dirname,
        "../../node_modules/@react-native-community/datetimepicker",
      ),
    },
    "@react-native-community/netinfo": {
      root: path.resolve(
        __dirname,
        "../../node_modules/@react-native-community/netinfo",
      ),
    },
    "@react-native-masked-view/masked-view": {
      root: path.resolve(
        __dirname,
        "../../node_modules/@react-native-masked-view/masked-view",
      ),
    },
    "react-native-enriched-markdown": {
      root: path.resolve(
        __dirname,
        "../../node_modules/react-native-enriched-markdown",
      ),
    },
    "react-native-gesture-handler": {
      root: path.resolve(
        __dirname,
        "../../node_modules/react-native-gesture-handler",
      ),
    },
    "react-native-keyboard-controller": {
      root: path.resolve(
        __dirname,
        "../../node_modules/react-native-keyboard-controller",
      ),
    },
    "react-native-reanimated": {
      root: path.resolve(__dirname, "../../node_modules/react-native-reanimated"),
    },
    "react-native-safe-area-context": {
      root: path.resolve(
        __dirname,
        "../../node_modules/react-native-safe-area-context",
      ),
    },
    "react-native-screens": {
      root: path.resolve(__dirname, "../../node_modules/react-native-screens"),
    },
    "react-native-shiki-engine": {
      root: path.resolve(
        __dirname,
        "../../node_modules/react-native-shiki-engine",
      ),
    },
    "react-native-svg": {
      root: path.resolve(__dirname, "../../node_modules/react-native-svg"),
    },
    "react-native-worklets": {
      root: path.resolve(__dirname, "../../node_modules/react-native-worklets"),
    },
  },
};
