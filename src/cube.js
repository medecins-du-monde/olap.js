const merge = require('lodash.merge');
const cloneDeep = require('lodash.clonedeep');
const DimensionFactory = require('./dimension/factory');
const CatchAllDimension = require('./dimension/catch-all');
const { fromNestedArray, toNestedArray } = require('./formatter/nested-array');
const { fromNestedObject, toNestedObject } = require('./formatter/nested-object');
const { toBuffer, fromBuffer } = require('./serialization');
const InMemoryStore = require('./store/in-memory');
const getParser = require('./parser');

class Cube {
    get storeSize() {
        return this.dimensions.reduce((m, d) => m * d.numItems, 1) * 2;
    }

    get byteLength() {
        return Object.values(this.storedMeasures).reduce((m, store) => m + store.byteLength, 0);
    }

    get dimensionIds() {
        return this.dimensions.map(d => d.id);
    }

    get storedMeasureIds() {
        return Object.keys(this.storedMeasures);
    }

    get computedMeasureIds() {
        return Object.keys(this.computedMeasures);
    }

    constructor(dimensions) {
        this.dimensions = dimensions;
        this.storedMeasures = {};
        this.storedMeasuresRules = {};
        this.computedMeasures = {};
    }

    getDimension(dimensionId) {
        return this.dimensions.find(d => d.id === dimensionId);
    }

    getDimensionIndex(dimensionId) {
        return this.dimensions.findIndex(d => d.id === dimensionId);
    }

    createComputedMeasure(measureId, formula) {
        if (!/^[a-z][_a-z0-9]+$/i.test(measureId))
            throw new Error(`Invalid measureId: ${measureId}`);

        if (
            this.storedMeasures[measureId] !== undefined ||
            this.computedMeasures[measureId] !== undefined
        )
            throw new Error('This measure already exists');

        const expression = getParser().parse(formula);
        const variables = expression.variables({ withMembers: true });
        if (!variables.every(variable => this.storedMeasureIds.includes(variable)))
            throw new Error(`Unknown measure: ${variable}`);

        this.computedMeasures[measureId] = expression;
    }

    createStoredMeasure(measureId, rules = {}, type = 'float32', defaultValue = NaN) {
        if (!/^[a-z][_a-z0-9]*$/i.test(measureId))
            throw new Error(`Invalid measureId: ${measureId}`);

        if (this.storedMeasures[measureId] !== undefined)
            throw new Error('This measure already exists');

        this.storedMeasures[measureId] = new InMemoryStore(this.storeSize, type, defaultValue);
        this.storedMeasuresRules[measureId] = rules;
    }

    renameMeasure(oldMeasureId, newMeasureId) {
        if (oldMeasureId == newMeasureId) return this;

        const cube = new Cube(this.dimensions);
        Object.assign(cube.storedMeasures, this.storedMeasures);
        Object.assign(cube.storedMeasuresRules, this.storedMeasuresRules);
        Object.assign(cube.computedMeasures, this.computedMeasures);

        if (cube.computedMeasures[oldMeasureId]) {
            cube.computedMeasures[newMeasureId] = cube.computedMeasures[oldMeasureId];
            delete cube.computedMeasures[oldMeasureId];
        } else if (cube.storedMeasures[oldMeasureId]) {
            cube.storedMeasures[newMeasureId] = cube.storedMeasures[oldMeasureId];
            cube.storedMeasuresRules[newMeasureId] = cube.storedMeasuresRules[oldMeasureId];
            delete cube.storedMeasures[oldMeasureId];
            delete cube.storedMeasuresRules[oldMeasureId];

            for (let measureId in cube.computedMeasures) {
                const expression = cube.computedMeasures[measureId];

                if (expression.variables().includes(oldMeasureId)) {
                    cube.computedMeasures[measureId] = expression.substitute(
                        oldMeasureId,
                        newMeasureId
                    );
                }
            }
        } else {
            throw new Error('No such measure');
        }

        return cube;
    }

    dropMeasure(measureId) {
        if (this.computedMeasures[measureId] !== undefined) delete this.computedMeasures[measureId];
        else if (this.storedMeasures[measureId] !== undefined) {
            delete this.storedMeasures[measureId];
            delete this.storedMeasuresRules[measureId];

            for (let measureId in cube.computedMeasures) {
                const expression = cube.computedMeasures[measureId];
                if (expression.variables().includes(measureId)) {
                    delete cube.computedMeasures[measureId];
                }
            }
        } else throw new Error('No such measure');
    }

    getData(measureId) {
        if (this.storedMeasures[measureId] !== undefined)
            return this.storedMeasures[measureId].data;
        else if (this.computedMeasures[measureId] !== undefined) {
            const storeSize = this.storeSize;
            const measureIds = this.storedMeasureIds;
            const measures = measureIds.map(id => this.storedMeasures[id]);
            const numMeasures = measures.length;

            // Fill result array
            const result = new Array(storeSize);
            const params = {};
            for (let i = 0; i < storeSize; ++i) {
                for (let j = 0; j < numMeasures; ++j)
                    params[measureIds[j]] = measures[j].getValue(i);

                result[i] = this.computedMeasures[measureId].evaluate(params);
            }

            return result;
        } else throw new Error('No such measure');
    }

    getStatus(measureId) {
        if (this.storedMeasures[measureId] !== undefined)
            return this.storedMeasures[measureId].status;
        else if (this.computedMeasures[measureId] !== undefined) {
            const result = new Array(this.storeSize);
            result.fill(0);
            for (let storedMeasureId in this.storedMeasures) {
                const status = this.storedMeasures[storedMeasureId].status;
                for (let i = 0; i < this.storeSize; ++i) result[i] |= status[i];
            }
            return result;
        } else throw new Error('No such measure');
    }

    setData(measureId, values) {
        if (this.storedMeasures[measureId]) {
            this.storedMeasures[measureId].data = values;
        } else throw new Error('setData can only be called on stored measures');
    }

    getNestedArray(measureId) {
        const data = this.getData(measureId);
        const status = this.getStatus(measureId);

        return toNestedArray(data, status, this.dimensions);
    }

    setNestedArray(measureId, values) {
        const data = fromNestedArray(values, this.dimensions);
        this.setData(measureId, data);
    }

    getNestedObject(measureId, withTotals = false, withMetadata = false) {
        if (!withTotals || this.dimensions.length == 0) {
            const data = this.getData(measureId);
            const status = this.getStatus(measureId);
            return toNestedObject(data, status, this.dimensions, withMetadata);
        }

        const result = {};
        for (let j = 0; j < 2 ** this.dimensions.length; ++j) {
            let subCube = this;
            for (let i = 0; i < this.dimensions.length; ++i)
                if (j & (1 << i)) subCube = subCube.drillUp(this.dimensions[i].id, 'all');

            merge(result, subCube.getNestedObject(measureId, false, withMetadata));
        }

        return result;
    }

    setNestedObject(measureId, value) {
        const data = fromNestedObject(value, this.dimensions);
        this.setData(measureId, data);
    }

    hydrateFromSparseNestedObject(measureId, obj, offset = 0, dimOffset = 0) {
        if (dimOffset === this.dimensions.length) {
            this.storedMeasures[measureId].setValue(offset, obj);
            return;
        }

        const dimension = this.dimensions[dimOffset];
        for (let key in obj) {
            const itemOffset = dimension.getRootIndexFromRootItem(key);
            if (itemOffset !== -1) {
                const newOffset = offset * dimension.numItems + itemOffset;
                this.hydrateFromSparseNestedObject(measureId, obj[key], newOffset, dimOffset + 1);
            }
        }
    }

    hydrateFromCube(otherCube) {
        // Exception == the cubes have no overlap, it is safe to skip this one.
        let compatibleCube;
        try {
            compatibleCube = otherCube.reshape(this.dimensions);
        } catch (e) {
            return;
        }

        for (let measureId in this.storedMeasures)
            if (compatibleCube.storedMeasures[measureId])
                this.storedMeasures[measureId].load(
                    compatibleCube.storedMeasures[measureId],
                    this.dimensions,
                    compatibleCube.dimensions
                );
    }

    project(dimensionIds) {
        return this.keepDimensions(dimensionIds).reorderDimensions(dimensionIds);
    }

    reorderDimensions(dimensionIds) {
        // Check for no-op
        let dimIdx = 0;
        for (; dimIdx < this.dimensions.length; ++dimIdx) {
            if (dimensionIds[dimIdx] !== this.dimensions[dimIdx].id) {
                break;
            }
        }

        if (dimIdx === this.dimensions.length) {
            return this;
        }

        // Write a new cube
        const newDimensions = dimensionIds.map(id => this.dimensions.find(dim => dim.id === id));
        const newCube = new Cube(newDimensions);
        newCube.computedMeasures = this.computedMeasures;
        newCube.storedMeasuresRules = this.storedMeasuresRules;
        for (let measureId in this.storedMeasures)
            newCube.storedMeasures[measureId] = this.storedMeasures[measureId].reorder(
                this.dimensions,
                newDimensions
            );

        return newCube;
    }

    slice(dimensionId, attribute, value) {
        let dimIndex = this.getDimensionIndex(dimensionId);
        if (dimIndex === -1) throw new Error('No such dimension.');

        return this.dice(dimensionId, attribute, [value]).removeDimension(dimensionId);
    }

    diceRange(dimensionId, attribute, start, end) {
        const dimIdx = this.getDimensionIndex(dimensionId);
        const newDimensions = this.dimensions.slice();
        newDimensions[dimIdx] = newDimensions[dimIdx].diceRange(attribute, start, end);
        if (newDimensions[dimIdx] == this.dimensions[dimIdx]) {
            return this;
        }

        const newCube = new Cube(newDimensions);
        newCube.computedMeasures = this.computedMeasures;
        newCube.storedMeasuresRules = this.storedMeasuresRules;
        for (let measureId in this.storedMeasures)
            newCube.storedMeasures[measureId] = this.storedMeasures[measureId].dice(
                this.dimensions,
                newDimensions
            );

        return newCube;
    }

    dice(dimensionId, attribute, items, reorder = false) {
        const dimIdx = this.getDimensionIndex(dimensionId);
        const newDimensions = this.dimensions.slice();
        newDimensions[dimIdx] = newDimensions[dimIdx].dice(attribute, items, reorder);
        if (newDimensions[dimIdx] == this.dimensions[dimIdx]) {
            return this;
        }

        const newCube = new Cube(newDimensions);
        newCube.computedMeasures = this.computedMeasures;
        newCube.storedMeasuresRules = this.storedMeasuresRules;
        for (let measureId in this.storedMeasures)
            newCube.storedMeasures[measureId] = this.storedMeasures[measureId].dice(
                this.dimensions,
                newDimensions
            );

        return newCube;
    }

    keepDimensions(dimensionIds) {
        let cube = this;
        for (let dimension of this.dimensions) {
            if (!dimensionIds.includes(dimension.id)) {
                cube = cube.removeDimension(dimension.id);
            }
        }

        return cube;
    }

    removeDimensions(dimensionIds) {
        let cube = this;
        for (let dimensionId of dimensionIds) {
            cube = cube.removeDimension(dimensionId);
        }

        return cube;
    }

    addDimension(newDimension, aggregation = {}, index = null) {
        // If index is not provided, we append the dimension
        index = index === null ? this.dimensions.length : index;

        const oldDimensions = this.dimensions.slice();
        oldDimensions.splice(index, 0, new CatchAllDimension(newDimension.id, newDimension));

        const newDimensions = oldDimensions.slice();
        newDimensions[index] = newDimension;

        const newCube = new Cube(newDimensions);
        newCube.computedMeasures = this.computedMeasures;
        newCube.storedMeasuresRules = cloneDeep(this.storedMeasuresRules);
        for (let measureId in this.storedMeasuresRules) {
            newCube.storedMeasuresRules[measureId][newDimension.id] = aggregation[measureId];
        }

        for (let measureId in this.storedMeasures)
            newCube.storedMeasures[measureId] = this.storedMeasures[measureId].drillDown(
                oldDimensions,
                newDimensions,
                aggregation[measureId]
            );

        return newCube;
    }

    removeDimension(dimensionId) {
        const newDimensions = this.dimensions.filter(dim => dim.id !== dimensionId);
        const newCube = new Cube(newDimensions);
        newCube.storedMeasures = this.drillUp(dimensionId, 'all').storedMeasures;
        newCube.computedMeasures = this.computedMeasures;
        newCube.storedMeasuresRules = cloneDeep(this.storedMeasuresRules);

        for (let measureId in newCube.storedMeasuresRules) {
            delete newCube.storedMeasuresRules[measureId][dimensionId];
        }

        return newCube;
    }

    drillDown(dimensionId, attribute) {
        const dimIdx = this.getDimensionIndex(dimensionId);
        if (this.dimensions[dimIdx].rootAttribute === attribute) return this;

        const newDimensions = this.dimensions.slice();
        newDimensions[dimIdx] = newDimensions[dimIdx].drillDown(attribute);
        if (newDimensions[dimIdx] == this.dimensions[dimIdx]) return this;

        const newCube = new Cube(newDimensions);
        newCube.computedMeasures = this.computedMeasures;
        newCube.storedMeasuresRules = this.storedMeasuresRules;
        for (let measureId in this.storedMeasures) {
            newCube.storedMeasures[measureId] = this.storedMeasures[measureId].drillDown(
                this.dimensions,
                newDimensions,
                this.storedMeasuresRules[measureId][dimensionId]
            );
        }

        return newCube;
    }

    /**
     * Aggregate a dimension by group values.
     * ie: minutes by hour, or cities by region.
     */
    drillUp(dimensionId, attribute) {
        const dimIdx = this.getDimensionIndex(dimensionId);
        if (this.dimensions[dimIdx].rootAttribute === attribute) return this;

        const newDimensions = this.dimensions.slice();
        newDimensions[dimIdx] = newDimensions[dimIdx].drillUp(attribute);
        if (newDimensions[dimIdx] == this.dimensions[dimIdx]) return this;

        const newCube = new Cube(newDimensions);
        newCube.computedMeasures = this.computedMeasures;
        newCube.storedMeasuresRules = this.storedMeasuresRules;
        for (let measureId in this.storedMeasures) {
            newCube.storedMeasures[measureId] = this.storedMeasures[measureId].drillUp(
                this.dimensions,
                newDimensions,
                this.storedMeasuresRules[measureId][dimensionId]
            );
        }

        return newCube;
    }

    /**
     * Create a new cube that contains the union of the measures
     *
     * This is useful when we want to create computed measures from different sources.
     * For instance, composing a cube with sells by day, and number of open hour per week,
     * to compute average sell by opening hour per week.
     */
    compose(otherCube, union = false) {
        let newDimensions = this.dimensions.reduce((m, myDimension) => {
            const otherDimension = otherCube.getDimension(myDimension.id);

            if (!otherDimension) return m;
            else if (union) return [...m, myDimension.union(otherDimension)];
            else return [...m, myDimension.intersect(otherDimension)];
        }, []);

        const newCube = new Cube(newDimensions);

        this.storedMeasureIds.forEach(measureId => {
            newCube.createStoredMeasure(measureId, this.storedMeasuresRules[measureId]);
            newCube.hydrateFromCube(this);
        });
        otherCube.storedMeasureIds.forEach(measureId => {
            newCube.createStoredMeasure(measureId, otherCube.storedMeasuresRules[measureId]);
            newCube.hydrateFromCube(otherCube);
        });

        Object.assign(newCube.computedMeasures, this.computedMeasures, otherCube.computedMeasures);
        return newCube;
    }

    reshape(targetDims) {
        let newCube = this;

        // Remove unneeded dimensions, and reorder.
        {
            const newCubeDimensionIds = newCube.dimensionIds;
            const commonDimensionIds = targetDims
                .filter(dim => newCubeDimensionIds.includes(dim.id))
                .map(dim => dim.id);

            newCube = newCube.project(commonDimensionIds);
        }

        // Add missing dimensions.
        for (let dimIndex = 0; dimIndex < targetDims.length; ++dimIndex) {
            const actualDim = newCube.dimensions[dimIndex];
            const targetDim = targetDims[dimIndex];

            if (!actualDim || actualDim.id !== targetDim.id) {
                // fixme: we're not providing aggregation rules to the dimensions that must be added.
                newCube = newCube.addDimension(targetDim, {}, dimIndex);
            }
        }

        // Drill to match root attributes
        for (let dimIndex = 0; dimIndex < targetDims.length; ++dimIndex) {
            const actualDim = newCube.dimensions[dimIndex];
            const targetDim = targetDims[dimIndex];

            if (actualDim.rootAttribute === targetDim.rootAttribute) {
                continue;
            } else if (actualDim.attributes.includes(targetDim.rootAttribute)) {
                newCube = newCube.drillUp(targetDim.id, targetDim.rootAttribute);
            } else if (targetDim.attributes.includes(actualDim.rootAttribute)) {
                newCube = newCube.drillDown(targetDim.id, targetDim.rootAttribute);
            } else {
                const err = `The cube dimensions '${targetDim.id}' are not compatible.`;
                throw new Error(err);
            }

            newCube = newCube.dice(
                targetDim.id,
                targetDim.rootAttribute,
                targetDim.getItems(),
                true
            );
        }

        return newCube;
    }

    serialize() {
        return toBuffer({
            dimensions: this.dimensions.map(dim => dim.serialize()),
            storedMeasuresKeys: Object.keys(this.storedMeasures),
            storedMeasures: Object.values(this.storedMeasures).map(measure => measure.serialize()),
            storedMeasuresRules: this.storedMeasuresRules,
            computedMeasures: this.computedMeasures,
        });
    }

    static deserialize(buffer) {
        const data = fromBuffer(buffer);
        const dimensions = data.dimensions.map(data => DimensionFactory.deserialize(data));

        const cube = new Cube(dimensions);
        cube.storedMeasures = {};
        cube.storedMeasuresRules = data.storedMeasuresRules;
        data.storedMeasuresKeys.forEach((key, i) => {
            cube.storedMeasures[key] = InMemoryStore.deserialize(data.storedMeasures[i]);
        });
        cube.computedMeasures = data.computedMeasures;
        return cube;
    }
}

module.exports = Cube;
