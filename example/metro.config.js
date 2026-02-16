const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const libraryRoot = path.resolve(__dirname, '..');

const escape = (p) => p.replace(/[/\\]/g, '[/\\\\]');

const config = {
  watchFolders: [libraryRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(libraryRoot, 'node_modules'),
    ],
    extraNodeModules: {
      '@rolobits/attestation-photo-mobile': libraryRoot,
    },
    // Prevent duplicate react / react-native from the library root
    blockList: [
      new RegExp(escape(path.resolve(libraryRoot, 'node_modules', 'react-native', '.*'))),
      new RegExp(escape(path.resolve(libraryRoot, 'node_modules', 'react', '.*'))),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
