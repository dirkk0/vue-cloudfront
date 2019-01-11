import config            from '../../../../config/config';
import {fileSystemUtils} from '../../../js/utils';

export const data = {

    namespaced: true,

    state: {

        // Uploads
        uploads: []
    },

    mutations: {

        /**
         * Resets the module state
         * @param state
         */
        reset(state) {
            state.uploads.splice(0, state.uploads.length);
        }
    },

    actions: {

        /**
         * Uploads files
         *
         * @param parent Target directory
         * @param dataTransfer drop dataTrasnsfer object
         */
        async upload({state}, {parent, dataTransfer: {files, items}}) {

            // Create new upload object
            const stats = {

                /**
                 * Available states are
                 * 'init' = Not started
                 * 'started' = Well, started
                 * 'create-dirs' = Creating directories
                 * 'upload-files' = Uploading files
                 * 'done' = Well done
                 *
                 * 'aborted' = Upload has been aborted
                 * 'failed' = Upload is failed (connection error etc.)
                 */
                state: 'init',
                total: 0, // Total upload bytes
                done: 0,  // Bytes uploaded so far
                dirs: [], // List of directory names
                files: [],    // List of file names
                dirNodes: [], // List of directorie nodes
                cancel: null  // Get's a function to abort the upload
            };

            state.uploads.push(stats);

            // Check if browser supports folder drag 'n drop
            let fileMap = {};
            if (items.length && (DataTransferItem.prototype.webkitGetAsEntry || DataTransferItem.prototype.getAsEntry)) {
                const getAsEntryFuncName = (DataTransferItem.prototype.webkitGetAsEntry || DataTransferItem.prototype.getAsEntry).name;
                const prequelFileMap = [];
                const folders = [];
                let folderIndex = 0;

                if (files.length) {
                    prequelFileMap[-1] = Array.from(files);
                }

                const traverseFileTree = async (parent, item) => {
                    if (item.isFile) {

                        // Resolve item
                        const fileObj = await new Promise((resolve, reject) => item.file(resolve, reject));
                        if (fileObj) {

                            if (!(parent in prequelFileMap)) {
                                prequelFileMap[parent] = [];
                            }

                            // Check if file aready exists
                            const fileList = prequelFileMap[parent];
                            if (!fileList.find(v => v.name === fileObj.name && v.size === fileObj.size && v.lastModified === fileObj.lastModified)) {
                                prequelFileMap[parent].push(fileObj);
                            }
                        }
                    } else if (item.isDirectory) {

                        // Resolve childs
                        const newFolder = {parent, name: item.name, id: folderIndex++};
                        const entries = await fileSystemUtils.readEntries(item);
                        for (let i = 0; i < entries.length; i++) {
                            await traverseFileTree(newFolder.id, entries[i]);
                        }

                        folders.push(newFolder);
                    }
                };

                let promises = [];
                for (let i = 0; i < items.length; i++) {
                    const entry = items[i][getAsEntryFuncName]();
                    entry && (promises.push(traverseFileTree(-1, entry)));
                }

                stats.state = 'stardet';
                await Promise.all(promises);

                // Create folders
                let idMap = {};
                if (folders.length) {

                    // Update state and save directory names
                    stats.state = 'create-dirs';
                    stats.dirs = folders.map(v => v.name);

                    // Create folders
                    const result = await this.dispatch('nodes/createFolders', {folders, parent});
                    idMap = result.idMap;

                    // Also save the new directorie ids into stats if user wants to cancel this upload
                    stats.dirNodes = result.nodes;
                } else {
                    idMap[-1] = parent.id;
                }

                // Map created folder ids to the filemap
                for (const [virtualId, files] of Object.entries(prequelFileMap)) {
                    const id = idMap[virtualId];

                    if (!id) {
                        throw `Can't found corresponding id in map: ${id} / ${JSON.stringify(idMap)}`;
                    }

                    fileMap[id] = files;
                }
            } else {
                fileMap[parent] = files;
            }

            // Upload files
            return this.dispatch('data/uploadFiles', {fileMap, stats}).then(() => {
                stats.state = 'done';
            }).catch(() => {
                stats.state = 'failed';
            });
        },

        /**
         * Responsible to upload single files
         * @returns {Promise<void>}
         */
        async uploadFiles({rootState}, {fileMap, stats}) {

            // Build form
            const formData = new FormData();

            const appendToForm = (key, val) => {
                stats.total += key.length + (typeof val === 'string' ? val.length : val.size);
                formData.append(key, val);
            };

            appendToForm('apikey', rootState.auth.apikey);
            for (const [parent, files] of Object.entries(fileMap)) {
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];

                    // Check if file is REALLY a file
                    if (await fileSystemUtils.isFile(file)) {
                        stats.files.push(file.name);
                        appendToForm(`${parent}-${i}`, file);
                    }
                }
            }

            /**
             * Currently fetch does not support upload-progression
             * see https://stackoverflow.com/questions/35711724/upload-progress-indicators-for-fetch
             * So instead use xmlhttprequest to track the upload progress
             */
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();

                stats.cancel = () => {
                    stats.state = 'aborted';
                    xhr.abort();
                    return this.dispatch('nodes/delete', stats.dirNodes);
                };

                let lastDone = 0;
                xhr.upload.onprogress = e => {
                    const done = e.position || e.loaded;
                    stats.done += done - lastDone;
                    lastDone = done;
                };

                xhr.onreadystatechange = () => {
                    if (xhr.readyState === 4) {
                        if (xhr.status === 200) {

                            // Parse and validate response
                            const {error, data} = JSON.parse(xhr.responseText);

                            if (error) {
                                reject();
                            } else {

                                // Append folder & file nodes
                                this.commit('nodes/put', {nodes: data.concat(stats.dirNodes)});
                                resolve();
                            }

                        } else if (stats.state !== 'aborted') {
                            reject('Request failed');
                        }
                    }
                };

                xhr.open(
                    'POST',
                    `${config.apiEndPoint}/upload`,
                    true
                );

                stats.state = 'upload-files';
                xhr.send(formData);
            });
        },

        /**
         * Initiates a download
         * @param state
         * @param rootState
         * @param node
         * @returns {Promise<void>}
         */
        async download({rootState}, {node}) {
            const link = document.createElement('a');
            document.body.appendChild(link);
            link.download = node.name;
            link.href = `${config.apiEndPoint}/download?id=${node.id}&apikey=${rootState.auth.apikey}`;
            link.click();
            document.body.removeChild(link);
        }
    }
};
