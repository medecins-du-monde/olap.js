const assert = require('chai').assert;
const createTestCube = require('./helpers/create-test-cube');
const { Cube, GenericDimension, TimeDimension } = require('../src');

describe("Dimension", function () {


	describe('addDimension', function () {

		it('should be able to add generic dimension', function () {
			const cube = new Cube([new TimeDimension('time', 'month', '2010-01', '2010-02')]);
			cube.createStoredMeasure('measure1', { time: 'sum' }, 100);
			cube.createStoredMeasure('measure2', { time: 'average' }, 100);

			const newDimension = new GenericDimension('location', 'city', ['paris', 'madrid', 'berlin'])
			const newCube = cube.addDimension(newDimension, { measure1: 'sum', measure2: 'average' });

			assert.deepEqual(
				newCube.removeDimension('location').getNestedObject('measure1'),
				cube.getNestedObject('measure1')
			);

			assert.deepEqual(
				newCube.removeDimension('location').getNestedObject('measure2'),
				cube.getNestedObject('measure2')
			);
		});

		it('should be able to add a time dimension', function () {
			const cube = new Cube([new TimeDimension('time1', 'month', '2010-01', '2010-02')]);
			cube.createStoredMeasure('measure1', { time: 'sum' }, 100);
			cube.createStoredMeasure('measure2', { time: 'average' }, 100);

			const newDimension = new TimeDimension('time2', 'week_mon', '2010-W01-mon', '2010-W08-mon')
			const newCube = cube.addDimension(newDimension, { measure1: 'sum', measure2: 'average' });

			assert.deepEqual(
				newCube.removeDimension('time2').getNestedObject('measure1'),
				cube.getNestedObject('measure1')
			);

			assert.deepEqual(
				newCube.removeDimension('time2').getNestedObject('measure2'),
				cube.getNestedObject('measure2')
			);
		});
	})

	describe("removeDimension", function () {
		let cube;

		beforeEach(function () {
			const period = new GenericDimension('period', 'season', ['summer', 'winter']);
			const location = new GenericDimension('location', 'city', ['paris', 'toledo', 'tokyo']);

			cube = new Cube([location, period]);
			for (let agg of ['sum', 'average', 'highest', 'lowest', 'first', 'last']) {
				cube.createStoredMeasure(`antennas_${agg}`, { period: agg, location: agg }, 0);
				cube.setNestedArray(`antennas_${agg}`, [[1, 2], [4, 8], [16, 32]]);
			}

			cube = cube.removeDimension('location');
		});

		it('should sum cities', function () {
			assert.deepEqual(cube.getNestedArray('antennas_sum'), [21, 42]);
		});

		it('should average cities', function () {
			assert.deepEqual(cube.getNestedArray('antennas_average'), [21 / 3, 42 / 3]);
		});

		it('should highest cities', function () {
			assert.deepEqual(cube.getNestedArray('antennas_highest'), [16, 32]);
		});

		it('should lowest cities', function () {
			assert.deepEqual(cube.getNestedArray('antennas_lowest'), [1, 2]);
		});

		it('should first cities', function () {
			assert.deepEqual(cube.getNestedArray('antennas_first'), [1, 2]);
		});

		it('should last cities', function () {
			assert.deepEqual(cube.getNestedArray('antennas_last'), [16, 32]);
		});
	});


	describe("reorderDimensions", function () {
		let cube;

		beforeEach(function () {
			cube = createTestCube(true, true);
		});

		it('should inverse the dimensions', function () {
			const inversed = cube.reorderDimensions(['period', 'location']);

			assert.equal(inversed.isInterpolated, false);
			assert.deepEqual(inversed.getNestedArray('antennas'), [[1, 4, 16], [2, 8, 32]]);
		});

	});

});


describe("Drilling", function () {

	describe("drillUp", function () {

		describe('cities to continents', function () {
			let cube, newCube;

			before(function () {
				cube = createTestCube(true, true);
				newCube = cube.drillUp('location', 'continent');
			});

			it('Drilled up cube should not be marked as interpolated', function () {
				assert.equal(newCube.isInterpolated, false);
			})

			it('Drilled up cube should have summed cities by continent', function () {
				assert.deepEqual(
					newCube.getNestedArray('antennas'),
					[[5, 10], [16, 32]]
				);
			});
		});
	});

	describe('drillDown', function () {

		describe('months to days', function () {
			let cube, newCube;

			before(function () {
				cube = new Cube([new TimeDimension('time', 'month', '2010-01', '2010-02')]);
				cube.createStoredMeasure('measure1', { time: 'sum' }, 100);
				cube.createStoredMeasure('measure2', { time: 'average' }, 100);

				newCube = cube.drillDown('time', 'day');
			});

			it('original cube should not be marked as interpolated', function () {
				assert.equal(cube.isInterpolated, false);
			});

			it('drilled down cube should be marked as interpolated', function () {
				assert.equal(newCube.isInterpolated, true);
			})

			it('when drilled up again to week, cube should still be interpolated', function () {
				assert.equal(
					newCube.drillUp('time', 'week_mon').isInterpolated,
					true
				);
			});

			it('when drilled up again to month, cube should no longer be interpolated', function () {
				assert.equal(
					newCube.drillUp('time', 'month').isInterpolated,
					false
				);
			});

			it('both measures should not have changed when drilled down and up again', function () {
				assert.deepEqual(
					newCube.drillUp('time', 'month').getNestedObject('measure1'),
					cube.getNestedObject('measure1')
				);

				assert.deepEqual(
					newCube.drillUp('time', 'month').getNestedObject('measure2'),
					cube.getNestedObject('measure2')
				);
			});
		});

		describe('months_week_mon to days', function () {
			let cube, newCube;

			before(function () {
				cube = new Cube([new TimeDimension('time', 'month_week_mon', '2010-01-W1-mon', '2010-02-W1-mon')]);
				cube.createStoredMeasure('measure1', { time: 'sum' }, 100);
				cube.createStoredMeasure('measure2', { time: 'average' }, 100);

				newCube = cube.drillDown('time', 'day');
			});

			it('original cube should not be marked as interpolated', function () {
				assert.equal(cube.isInterpolated, false);
			});

			it('drilled down cube should be marked as interpolated', function () {
				assert.equal(newCube.isInterpolated, true);
			})

			it('when drilled up again to week_mon, cube should no longer be interpolated', function () {
				assert.equal(
					newCube.drillUp('time', 'week_mon').isInterpolated,
					false
				);
			});

			it('when drilled up again to week_sat, cube should should be interpolated', function () {
				assert.equal(
					newCube.drillUp('time', 'week_sat').isInterpolated,
					true
				);
			});

			it('both measures should not have changed when drilled down and up again', function () {
				assert.deepEqual(
					newCube.drillUp('time', 'month_week_mon').getNestedObject('measure1'),
					cube.getNestedObject('measure1')
				);

				assert.deepEqual(
					newCube.drillUp('time', 'month_week_mon').getNestedObject('measure2'),
					cube.getNestedObject('measure2')
				);
			});
		});
	});
});

