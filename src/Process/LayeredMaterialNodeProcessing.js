import { chooseNextLevelToFetch } from 'Layer/LayerUpdateStrategy';
import LayerUpdateState from 'Layer/LayerUpdateState';
import { ImageryLayers } from 'Layer/Layer';
import CancelledCommandException from 'Core/Scheduler/CancelledCommandException';
import { SIZE_TEXTURE_TILE } from 'Provider/OGCWebServiceHelper';
import computeMinMaxElevation from 'Parser/XbilParser';

// max retry loading before changing the status to definitiveError
const MAX_RETRY = 4;

function getSourceExtent(node, extent, targetLevel, source) {
    if (source && source.getSourceExtents) {
        return source.getSourceExtents(extent).extent;
    } else if (extent.isTiledCrs()) {
        return extent.extentParent(targetLevel);
    } else {
        const parent = node.findAncestorFromLevel(targetLevel);
        if (parent.extent) {
            // Needed to initNodeElevationTextureFromParent, insertSignificantValuesFromParent,
            // isColorLayerDownscaled
            // Must be removed
            parent.extent.zoom = parent.level;
        }
        return parent.extent;
    }
}

// TODO Move to XBilParser
function getIndiceWithPitch(i, pitch, w) {
    // Return corresponding indice in parent tile using pitch
    const currentX = (i % w) / w;  // normalized
    const currentY = Math.floor(i / w) / w; // normalized
    const newX = pitch.x + currentX * pitch.z;
    const newY = pitch.y + currentY * pitch.w;
    const newIndice = Math.floor(newY * w) * w + Math.floor(newX * w);
    return newIndice;
}

// TODO Move to XBilParser
// This function replaces noDataValue by significant values from parent texture
function insertSignificantValuesFromParent(data, node, parent, layer) {
    const nodeParent = parent.material && parent.material.getElevationLayer();
    const parentTexture = nodeParent && nodeParent.textures[0];
    if (parentTexture) {
        const coords = node.getCoordsForSource(layer.source);
        const pitch = coords[0].offsetToParent(parentTexture.coords);

        for (let i = 0, l = data.length; i < l; ++i) {
            if (data[i] === layer.noDataValue) {
                data[i] = parentTexture.image.data[getIndiceWithPitch(i, pitch, 256)];
            }
        }
    }
}

function materialCommandQueuePriorityFunction(material) {
    // We know that 'node' is visible because commands can only be
    // issued for visible nodes.

    // TODO: need priorization of displayed nodes
    if (material.visible) {
        // Then prefer displayed node over non-displayed one
        return 100;
    } else {
        return 10;
    }
}

function refinementCommandCancellationFn(cmd) {
    if (!cmd.requester.parent || !cmd.requester.material) {
        return true;
    }
    if (cmd.force) {
        return false;
    }

    // Cancel the command if the tile already has a better texture.
    // This is only needed for elevation layers, because we may have several
    // concurrent layers but we can only use one texture.
    if (cmd.layer.type == 'elevation' && cmd.requester.material.getElevationLayer() &&
        cmd.targetLevel <= cmd.requester.material.getElevationLayer().level) {
        return true;
    }

    return !cmd.requester.material.visible;
}

// TODO Move to XBilParser
function checkNodeElevationTextureValidity(texture, noDataValue) {
    // We check if the elevation texture has some significant values through corners
    const tData = texture.image.data;
    const l = tData.length;
    return tData[0] > noDataValue &&
           tData[l - 1] > noDataValue &&
           tData[Math.sqrt(l) - 1] > noDataValue &&
           tData[l - Math.sqrt(l)] > noDataValue;
}

export function updateLayeredMaterialNodeImagery(context, layer, node, parent) {
    const material = node.material;
    if (!parent || !material) {
        return;
    }

    const extentsDestination = node.getCoordsForSource(layer.source);

    let nodeLayer = material.getLayer(layer.id);

    // Initialisation
    if (node.layerUpdateState[layer.id] === undefined) {
        node.layerUpdateState[layer.id] = new LayerUpdateState();

        if (!layer.source.extentsInsideLimit(extentsDestination)) {
            // we also need to check that tile's parent doesn't have a texture for this layer,
            // because even if this tile is outside of the layer, it could inherit it's
            // parent texture
            if (!layer.noTextureParentOutsideLimit &&
                parent.material &&
                parent.material.getLayer &&
                parent.material.getLayer(layer.id)) {
                // ok, we're going to inherit our parent's texture
            } else {
                node.layerUpdateState[layer.id].noMoreUpdatePossible();
                return;
            }
        }

        if (!nodeLayer) {
            // Create new MaterialLayer
            const tileMT = layer.options.tileMatrixSet || extentsDestination[0].crs();
            nodeLayer = material.addLayer(layer, tileMT);

            // TODO: Sequence must be returned by parent geometry layer
            const colorLayers = context.view.getLayers(l => l.type === 'color');
            const sequence = ImageryLayers.getColorLayersIdOrderedBySequence(colorLayers);
            material.setSequence(sequence);

            // Init the new MaterialLayer by parent
            const parentLayer = parent.material && parent.material.getLayer(layer.id);
            nodeLayer.initFromParent(parentLayer, extentsDestination);
        }

        // Proposed new process, two separate processes:
        //      * FIRST PASS: initNodeXXXFromParent and get out of the function
        //      * SECOND PASS: Fetch best texture

        // The two-step allows you to filter out unnecessary requests
        // Indeed in the second pass, their state (not visible or not displayed) can block them to fetch
        if (nodeLayer.level >= layer.source.zoom.min) {
            context.view.notifyChange(node, false);
            return;
        }
    }

    // Node is hidden, no need to update it
    if (!material.visible) {
        return;
    }

    // TODO: move this to defineLayerProperty() declaration
    // to avoid mixing layer's network updates and layer's params
    // Update material parameters
    if (nodeLayer) {
        nodeLayer.visible = layer.visible;
        nodeLayer.opacity = layer.opacity;
    }

    const ts = Date.now();
    // An update is pending / or impossible -> abort
    if (!layer.visible || !node.layerUpdateState[layer.id].canTryUpdate(ts)) {
        return;
    }

    if (layer.source.canTileTextureBeImproved) {
        // if the layer has a custom method -> use it
        if (!layer.source.canTileTextureBeImproved(node.extent, material.getLayerTextures(layer)[0])) {
            node.layerUpdateState[layer.id].noMoreUpdatePossible();
            return;
        }
    } else if (nodeLayer.level >= node.getZoomForLayer(layer)) {
        // default decision method
        node.layerUpdateState[layer.id].noMoreUpdatePossible();
        return;
    }

    // is fetching data from this layer disabled?
    if (layer.frozen) {
        return;
    }

    const failureParams = node.layerUpdateState[layer.id].failureParams;
    const destinationLevel = extentsDestination[0].zoom || node.level;
    const targetLevel = chooseNextLevelToFetch(layer.updateStrategy.type, node, destinationLevel, nodeLayer.level, layer, failureParams);
    if (targetLevel <= nodeLayer.level) {
        return;
    }

    // Get equivalent of extent destination in source
    const extentsSource = [];
    for (const extentDestination of extentsDestination) {
        const extentSource = getSourceExtent(node, extentDestination, targetLevel, layer.source);
        if (extentSource && !layer.source.extentInsideLimit(extentSource)) {
            // Retry extentInsideLimit because you must check with the targetLevel
            // if the first test extentInsideLimit returns that it is out of limits
            // and the node inherits from its parent, then it'll still make a command to fetch texture.
            node.layerUpdateState[layer.id].noMoreUpdatePossible();
            return;
        }
        extentsSource.push(extentSource);
    }

    node.layerUpdateState[layer.id].newTry();
    const command = {
        /* mandatory */
        view: context.view,
        layer,
        extentsSource,
        extentsDestination,
        parsedData: layer.source.parsedData,
        requester: node,
        priority: materialCommandQueuePriorityFunction(material),
        earlyDropFunction: refinementCommandCancellationFn,
    };

    return context.scheduler.execute(command).then(
        (result) => {
            if (material === null) {
                return;
            }

            const pitchs = extentsDestination.map((ext, i) => ext.offsetToParent(extentsSource[i]));
            if (result) {
                nodeLayer.setTextures(result, pitchs);
            } else {
                // TODO: null texture is probably an error
                // Maybe add an error counter for the node/layer,
                // and stop retrying after X attempts.
            }

            node.layerUpdateState[layer.id].success();

            return result;
        },
        (err) => {
            if (err instanceof CancelledCommandException) {
                node.layerUpdateState[layer.id].success();
            } else {
                if (__DEBUG__) {
                    console.warn('Imagery texture update error for', node, err);
                }
                const definitiveError = node.layerUpdateState[layer.id].errorCount > MAX_RETRY;
                node.layerUpdateState[layer.id].failure(Date.now(), definitiveError, { targetLevel });
                if (!definitiveError) {
                    window.setTimeout(() => {
                        context.view.notifyChange(node, false);
                    }, node.layerUpdateState[layer.id].secondsUntilNextTry() * 1000);
                }
            }
        });
}

export function updateLayeredMaterialNodeElevation(context, layer, node, parent) {
    const material = node.material;
    if (!parent || !material) {
        return;
    }

    // TODO: we need either
    //  - compound or exclusive layers
    //  - support for multiple elevation layers

    // Elevation is currently handled differently from color layers.
    // This is caused by a LayeredMaterial limitation: only 1 elevation texture
    // can be used (where a tile can have N textures x M layers)
    const extentsDestination = node.getCoordsForSource(layer.source);
    const tileMT = layer.options.tileMatrixSet || extentsDestination[0].crs();
    // Init elevation layer, and inherit from parent if possible
    let nodeLayer = material.getElevationLayer();
    if (node.layerUpdateState[layer.id] === undefined) {
        node.layerUpdateState[layer.id] = new LayerUpdateState();
        if (!nodeLayer) {
            nodeLayer = material.addLayer(layer, tileMT);
            material.setSequenceElevation(layer.id);
        }

        const parentLayer = parent.material && parent.material.getLayer(layer.id);
        nodeLayer.initFromParent(parentLayer, extentsDestination);

        // If the texture resolution has a poor precision for this node, we don't
        // extract min-max from the texture (too few information), we instead chose
        // to use parent's min-max.
        const useMinMaxFromParent = extentsDestination[0].zoom - nodeLayer.zoom > 6;
        if (nodeLayer.textures[0] && !useMinMaxFromParent) {
            const { min, max } =  computeMinMaxElevation(
                nodeLayer.textures[0].image.data,
                SIZE_TEXTURE_TILE, SIZE_TEXTURE_TILE,
                nodeLayer.offsetScales[0]);
            node.setBBoxZ(min, max);
        }

        if (nodeLayer.level >= layer.source.zoom.min) {
            context.view.notifyChange(node, false);
            return;
        }
    }

    // Try to update
    const ts = Date.now();

    // Possible conditions to *not* update the elevation texture
    if (layer.frozen ||
            !material.visible ||
            !node.layerUpdateState[layer.id].canTryUpdate(ts)) {
        return;
    }

    // Does this tile needs a new texture?
    if (layer.source.canTileTextureBeImproved) {
        // if the layer has a custom method -> use it
        if (!layer.source.canTileTextureBeImproved(layer, node)) {
            node.layerUpdateState[layer.id].noMoreUpdatePossible();
            return;
        }
    }

    const targetLevel = chooseNextLevelToFetch(layer.updateStrategy.type, node, extentsDestination[0].zoom, nodeLayer.level, layer);

    if (targetLevel <= nodeLayer.level) {
        node.layerUpdateState[layer.id].noMoreUpdatePossible();
        return Promise.resolve();
    }

    const extentsSource = [];
    for (const nodeExtent of extentsDestination) {
        const extentSource = getSourceExtent(node, nodeExtent, targetLevel);
        if (extentSource && !layer.source.extentInsideLimit(extentSource)) {
            node.layerUpdateState[layer.id].noMoreUpdatePossible();
            return;
        }
        extentsSource.push(extentSource);
    }

    node.layerUpdateState[layer.id].newTry();

    const command = {
        /* mandatory */
        view: context.view,
        layer,
        extentsSource,
        extentsDestination,
        requester: node,
        priority: materialCommandQueuePriorityFunction(material),
        earlyDropFunction: refinementCommandCancellationFn,
    };

    return context.scheduler.execute(command).then(
        (textures) => {
            const elevation = {
                texture: textures[0],
                pitch: extentsDestination[0].offsetToParent(extentsSource[0]),
            };

            // Do not apply the new texture if its level is < than the current
            // one.  This is only needed for elevation layers, because we may
            // have several concurrent layers but we can only use one texture.
            if (targetLevel <= nodeLayer.level) {
                node.layerUpdateState[layer.id].noMoreUpdatePossible();
                return;
            }

            node.layerUpdateState[layer.id].success();

            if (elevation.texture) {
                if (elevation.texture.flipY) {
                    // DataTexture default to false, so make sure other Texture
                    // types do the same (eg image texture).  See UV construction
                    // for more details.
                    elevation.texture.flipY = false;
                    elevation.texture.needsUpdate = true;
                }

                if (elevation.texture.image.data) {
                    if (!checkNodeElevationTextureValidity(elevation.texture, layer.noDataValue)) {
                        // Quick check to avoid using elevation texture with no data
                        // value. If we have no data values, we use value from the
                        // parent tile. We should later implement multi elevation layer
                        // to choose the one to use at each level.
                        insertSignificantValuesFromParent(elevation.texture.image.data, node, parent, layer);
                    }


                    const { min, max } = computeMinMaxElevation(elevation.texture.image.data);
                    elevation.min = !min ? 0 : min;
                    elevation.max = !max ? 0 : max;
                } else if (layer.useColorTextureElevation) {
                    elevation.min = layer.colorTextureElevationMinZ;
                    elevation.max = layer.colorTextureElevationMaxZ;
                }
            }

            node.setBBoxZ(elevation.min, elevation.max);
            nodeLayer = material.getLayer(layer.id);
            if (!nodeLayer) {
                nodeLayer = material.addLayer(layer, tileMT);
            }
            material.setSequenceElevation(layer.id);
            nodeLayer.setTexture(0, elevation.texture, elevation.pitch);
        },
        (err) => {
            if (err instanceof CancelledCommandException) {
                node.layerUpdateState[layer.id].success();
            } else {
                if (__DEBUG__) {
                    console.warn('Elevation texture update error for', node, err);
                }
                const definitiveError = node.layerUpdateState[layer.id].errorCount > MAX_RETRY;
                node.layerUpdateState[layer.id].failure(Date.now(), definitiveError);
                if (!definitiveError) {
                    window.setTimeout(() => {
                        context.view.notifyChange(node, false);
                    }, node.layerUpdateState[layer.id].secondsUntilNextTry() * 1000);
                }
            }
        });
}

export function removeLayeredMaterialNodeLayer(layerId) {
    return function removeLayeredMaterialNodeLayer(node) {
        if (node.material && node.material.removeLayer) {
            node.material.removeLayer(layerId);
        }
        if (node.layerUpdateState && node.layerUpdateState[layerId]) {
            delete node.layerUpdateState[layerId];
        }
    };
}
