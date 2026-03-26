const fs = require('fs');
const path = require('path');

const baseDir = './textures/blocks';
const folders = ['block', 'prop', 'water', 'background'];
let assetList = [];

folders.forEach(folder => {
    const dirPath = path.join(baseDir, folder);
    if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath);
        files.forEach(file => {
            if (file.toLowerCase().endsWith('.png')) {
                const labelName = file.replace('.png', '').replace(/_/g, ' ');

                assetList.push({
                    label: labelName,
                    folder: folder,
                    file: file,
                    type: folder === 'background' ? 'wall' : (folder === 'water' ? 'water' : (folder === 'prop' ? 'prop' : 'block'))
                });
            }
        });
    }
});

const output = `const ASSET_LIST = ${JSON.stringify(assetList, null, 2)};`;
fs.writeFileSync('./asset_list.js', output);
console.log(`Successfully indexed ${assetList.length} assets into asset_list.js!`);