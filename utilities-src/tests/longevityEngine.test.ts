import { longevityDataset } from '@utilities/longevityDataset';
import {
  computeMortalityProjectionFactor,
  formatCountdown,
  formatCountdownDisplay,
  predictLongevity
} from '@utilities/longevityEngine';
import type { LongevityDataset, LongevitySurveyAnswers } from '@utilities/longevityTypes';

function createBaselineAnswers(overrides: Partial<LongevitySurveyAnswers> = {}): LongevitySurveyAnswers {
  return {
    birthDate: '1994-04-08',
    sex: 'male',
    heightInches: 70,
    weightPounds: 170,
    moderateMinutesPerWeek: 90,
    vigorousMinutesPerWeek: 0,
    strengthDaysPerWeek: 1,
    sedentaryHoursPerDay: 8,
    smokingStatus: 'never',
    yearsSinceQuit: null,
    drinksPerWeek: 0,
    bingeFrequency: 'never',
    sleepHoursPerNight: 8,
    ultraProcessedFoodShare: 'low',
    fruitVegetableServingsPerDay: 4,
    hasHypertension: false,
    diabetesStatus: 'none',
    hasCardiovascularDisease: false,
    hasCancerHistory: false,
    hasCopdOrAsthma: false,
    hasChronicKidneyDisease: false,
    hasSleepApnea: false,
    hasEarlyFamilyCardioHistory: false,
    parentLongevityBand: 'mixed',
    ...overrides
  };
}

function createStaticProjectionDataset(): LongevityDataset {
  return {
    ...longevityDataset,
    mortalityProjection: {
      ...longevityDataset.mortalityProjection,
      id: 'static-period-baseline',
      label: 'Static period baseline',
      annualImprovementUnder65: 0,
      annualImprovement65Plus: 0
    }
  };
}

describe('longevity engine', () => {
  const now = new Date('2026-04-08T12:00:00Z');

  it('keeps a near-neutral baseline close to the underlying life table', () => {
    const prediction = predictLongevity(createBaselineAnswers(), longevityDataset, now);

    expect(prediction.totalHazardMultiplier).toBeGreaterThan(0.9);
    expect(prediction.totalHazardMultiplier).toBeLessThan(1.15);
    expect(prediction.baselineRemainingLifeExpectancy).toBeGreaterThan(40);
  });

  it('orders percentile dates from earliest to latest', () => {
    const prediction = predictLongevity(createBaselineAnswers(), longevityDataset, now);

    expect(prediction.percentileTimestamps.p10).toBeLessThan(prediction.percentileTimestamps.p25);
    expect(prediction.percentileTimestamps.p25).toBeLessThan(prediction.percentileTimestamps.p50);
    expect(prediction.percentileTimestamps.p50).toBeLessThan(prediction.percentileTimestamps.p75);
    expect(prediction.percentileTimestamps.p75).toBeLessThan(prediction.percentileTimestamps.p90);
  });

  it('uses future mortality improvement to lower projected hazards', () => {
    const factor = computeMortalityProjectionFactor(longevityDataset.mortalityProjection, 2050, 50);

    expect(factor).toBeLessThan(1);
    expect(factor).toBeCloseTo(Math.pow(1 - longevityDataset.mortalityProjection.annualImprovementUnder65, 26));
  });

  it('does not apply mortality improvement before the projection window advances', () => {
    expect(computeMortalityProjectionFactor(longevityDataset.mortalityProjection, 2023, 50)).toBe(1);
    expect(computeMortalityProjectionFactor(longevityDataset.mortalityProjection, 2024, 50)).toBe(1);
  });

  it('moves the prior sample scenario later than the static period model', () => {
    const sampleAnswers = createBaselineAnswers({
      birthDate: '1989-05-14',
      heightInches: 71,
      weightPounds: 192,
      moderateMinutesPerWeek: 180,
      vigorousMinutesPerWeek: 40,
      strengthDaysPerWeek: 3,
      sedentaryHoursPerDay: 7,
      smokingStatus: 'former',
      yearsSinceQuit: 12,
      drinksPerWeek: 4,
      sleepHoursPerNight: 7.5,
      ultraProcessedFoodShare: 'moderate',
      fruitVegetableServingsPerDay: 5,
      hasHypertension: true,
      diabetesStatus: 'prediabetes',
      hasCardiovascularDisease: true,
      hasCancerHistory: true,
      hasCopdOrAsthma: true,
      hasChronicKidneyDisease: true,
      hasSleepApnea: true,
      hasEarlyFamilyCardioHistory: true,
      parentLongevityBand: 'one-85-plus'
    });
    const staticProjection = predictLongevity(sampleAnswers, createStaticProjectionDataset(), now);
    const projected = predictLongevity(sampleAnswers, longevityDataset, now);

    expect(projected.medianTimestamp).toBeGreaterThan(staticProjection.medianTimestamp);
    expect(projected.projectedBaselineAdjustment).toBeLessThan(1);
  });

  it('assigns lower survival to heavy smokers than to never-smokers', () => {
    const never = predictLongevity(createBaselineAnswers(), longevityDataset, now);
    const heavy = predictLongevity(
      createBaselineAnswers({
        smokingStatus: 'heavy'
      }),
      longevityDataset,
      now
    );

    expect(heavy.medianTimestamp).toBeLessThan(never.medianTimestamp);
    expect(heavy.survivalProbabilities.years20).toBeLessThan(never.survivalProbabilities.years20);
  });

  it('keeps major disease burden larger than modest diet improvements', () => {
    const healthierDiet = predictLongevity(
      createBaselineAnswers({
        ultraProcessedFoodShare: 'minimal',
        fruitVegetableServingsPerDay: 8
      }),
      longevityDataset,
      now
    );
    const majorDisease = predictLongevity(
      createBaselineAnswers({
        ultraProcessedFoodShare: 'minimal',
        fruitVegetableServingsPerDay: 8,
        hasCardiovascularDisease: true,
        diabetesStatus: 'diabetes'
      }),
      longevityDataset,
      now
    );

    expect(majorDisease.totalHazardMultiplier).toBeGreaterThan(healthierDiet.totalHazardMultiplier + 0.5);
    expect(majorDisease.medianTimestamp).toBeLessThan(healthierDiet.medianTimestamp);
  });

  it('does not let extra activity overpower major diagnosed disease history', () => {
    const activeWithDisease = predictLongevity(
      createBaselineAnswers({
        moderateMinutesPerWeek: 300,
        vigorousMinutesPerWeek: 120,
        strengthDaysPerWeek: 4,
        hasCardiovascularDisease: true,
        diabetesStatus: 'diabetes'
      }),
      longevityDataset,
      now
    );
    const ordinaryHealthy = predictLongevity(createBaselineAnswers(), longevityDataset, now);

    expect(activeWithDisease.medianTimestamp).toBeLessThan(ordinaryHealthy.medianTimestamp);
    expect(activeWithDisease.totalHazardMultiplier).toBeGreaterThan(ordinaryHealthy.totalHazardMultiplier);
  });

  it('worsens monotonically as ultra-processed food share rises', () => {
    const minimal = predictLongevity(
      createBaselineAnswers({
        ultraProcessedFoodShare: 'minimal'
      }),
      longevityDataset,
      now
    );
    const moderate = predictLongevity(
      createBaselineAnswers({
        ultraProcessedFoodShare: 'moderate'
      }),
      longevityDataset,
      now
    );
    const veryHigh = predictLongevity(
      createBaselineAnswers({
        ultraProcessedFoodShare: 'very-high'
      }),
      longevityDataset,
      now
    );

    expect(minimal.totalHazardMultiplier).toBeLessThan(moderate.totalHazardMultiplier);
    expect(moderate.totalHazardMultiplier).toBeLessThan(veryHigh.totalHazardMultiplier);
  });

  it('formats countdowns across leap-year and day boundaries', () => {
    const countdown = formatCountdown(
      Date.parse('2028-03-01T00:00:05Z'),
      Date.parse('2027-02-28T23:59:00Z')
    );

    expect(countdown.expired).toBe(false);
    expect(countdown.years).toBe(1);
    expect(countdown.days).toBe(1);
    expect(countdown.hours).toBe(0);
    expect(countdown.minutes).toBe(1);
    expect(countdown.seconds).toBe(5);
  });

  it('renders countdown display strings with padded segments', () => {
    expect(
      formatCountdownDisplay(
        Date.parse('2028-03-01T00:00:05Z'),
        Date.parse('2027-02-28T23:59:00Z')
      )
    ).toBe('01:001:00:01:05');
  });
});
