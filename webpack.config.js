const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

module.exports = (env) => {
    const includeWebLLM = env && env.webllm;
    console.log("Build configuration: Include WebLLM =", !!includeWebLLM);

    return {
        mode: 'production',
        entry: {
            popup: './src/popup/popup.ts',
            background: './src/background/background.ts',
            content: './src/content/content.ts',
            offscreen: './src/offscreen/offscreen.ts',
        },
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: '[name].js',
            clean: true,
        },
        resolve: {
            extensions: ['.ts', '.js'],
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
            ],
        },
        plugins: [
            new CopyPlugin({
                patterns: [
                    { from: 'src/popup/popup.html', to: 'popup.html' },
                    { from: 'src/popup/popup.css', to: 'popup.css' },
                    { from: 'src/offscreen/offscreen.html', to: 'offscreen.html' },
                    { from: 'manifest.json', to: 'manifest.json' },
                    { from: 'src/icons', to: 'icons' },
                    { 
                        from: 'node_modules/@huggingface/transformers/dist/*.wasm', 
                        to: '[name][ext]' 
                    },
                    { 
                        from: 'node_modules/@huggingface/transformers/dist/*.mjs', 
                        to: '[name][ext]' 
                    },
                ],
            }),
            new webpack.DefinePlugin({
                'process.env.INCLUDE_WEBLLM': JSON.stringify(includeWebLLM),
            }),
        ],
    };
};
