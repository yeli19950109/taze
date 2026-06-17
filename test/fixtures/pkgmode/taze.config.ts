import { defineConfig } from '@whyjs/taze'

export default defineConfig({
  exclude: [
    'lodash',
  ],
  packageMode: {
    'typescript': 'major',
    'unocss': 'ignore',
    '/vue/': 'latest',
  },
})
