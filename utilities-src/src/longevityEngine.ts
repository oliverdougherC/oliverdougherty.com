import type {
  CorrelationGroup,
  HazardAdjustmentRule,
  LongevityDataset,
  LongevityImpactRow,
  LongevitySurveyAnswers,
  MortalityBaselineEntry,
  MortalityProjectionConfig,
  PredictionResult,
  RangeHazardBand
} from './longevityTypes';

export const DAYS_PER_YEAR = 365.2425;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SURVIVAL_PERCENTILES = {
  p10: 0.9,
  p25: 0.75,
  p50: 0.5,
  p75: 0.25,
  p90: 0.1
} as const;

function parseBirthDateUtc(birthDate: string) {
  const parsed = new Date(`${birthDate}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Birth date is invalid.');
  }
  return parsed;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function findRangeBand(bands: RangeHazardBand[], value: number) {
  return bands.find((band) => value >= band.min && value < band.max) ?? bands[bands.length - 1];
}

function annualHazardFromQx(qx: number) {
  return -Math.log(1 - clamp(qx, 1e-9, 0.999999));
}

function lerp(start: number, end: number, factor: number) {
  return start + (end - start) * factor;
}

function interpolateAnnualHazard(entries: MortalityBaselineEntry[], ageYears: number) {
  if (ageYears <= entries[0].age) {
    return annualHazardFromQx(entries[0].qx);
  }

  const lastEntry = entries[entries.length - 1];
  if (ageYears >= lastEntry.age) {
    return annualHazardFromQx(lastEntry.qx);
  }

  const lowerAge = Math.floor(ageYears);
  const upperAge = Math.min(lowerAge + 1, lastEntry.age);
  const lowerEntry = findEntryByAge(entries, lowerAge) ?? lastEntry;
  const upperEntry = findEntryByAge(entries, upperAge) ?? lastEntry;
  const factor = ageYears - lowerAge;
  const lowerHazard = Math.log(annualHazardFromQx(lowerEntry.qx));
  const upperHazard = Math.log(annualHazardFromQx(upperEntry.qx));
  return Math.exp(lerp(lowerHazard, upperHazard, factor));
}

function findEntryByAge(entries: MortalityBaselineEntry[], age: number) {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const entryAge = entries[mid].age;
    if (entryAge === age) {
      return entries[mid];
    }
    if (entryAge < age) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return null;
}

export function computeMortalityProjectionFactor(
  projection: MortalityProjectionConfig,
  calendarYear: number,
  ageYears: number
) {
  const cappedYear = Math.min(Math.floor(calendarYear), projection.terminalYear);
  const projectedYears = Math.max(0, cappedYear - projection.startYear);
  if (projectedYears === 0) {
    return 1;
  }

  const annualImprovement =
    ageYears < 65 ? projection.annualImprovementUnder65 : projection.annualImprovement65Plus;
  return Math.pow(1 - clamp(annualImprovement, 0, 0.2), projectedYears);
}

function interpolateRemainingLifeExpectancy(entries: MortalityBaselineEntry[], ageYears: number) {
  const lowerAge = Math.floor(ageYears);
  const upperAge = Math.min(lowerAge + 1, entries[entries.length - 1].age);
  const lowerEntry = findEntryByAge(entries, lowerAge) ?? entries[entries.length - 1];
  const upperEntry = findEntryByAge(entries, upperAge) ?? entries[entries.length - 1];
  const factor = clamp(ageYears - lowerAge, 0, 1);
  return lerp(lowerEntry.ex, upperEntry.ex, factor);
}

export function computeBodyMassIndex(heightInches: number, weightPounds: number) {
  if (heightInches <= 0 || weightPounds <= 0) {
    throw new Error('Height and weight must be greater than zero.');
  }
  return (weightPounds / (heightInches * heightInches)) * 703;
}

function hasMeasuredBloodPressure(answers: LongevitySurveyAnswers) {
  return answers.systolicBloodPressure !== null || answers.diastolicBloodPressure !== null;
}

function hasMeasuredCholesterol(answers: LongevitySurveyAnswers) {
  return answers.totalCholesterol !== null && answers.hdlCholesterol !== null && answers.hdlCholesterol > 0;
}

function createDriver(
  id: string,
  label: string,
  category: HazardAdjustmentRule['category'],
  correlationGroup: CorrelationGroup,
  rawLogHazard: number,
  sourceIds: string[]
): HazardAdjustmentRule {
  return {
    id,
    label,
    category,
    correlationGroup,
    rawLogHazard,
    adjustedLogHazard: rawLogHazard,
    sourceIds
  };
}

function applyCorrelationShrinkage(
  drivers: HazardAdjustmentRule[],
  currentAgeYears: number,
  dataset: LongevityDataset
) {
  const nextDrivers = drivers.map((driver) => ({ ...driver }));
  const { shrinkage, clamp: clampBands } = dataset.coefficients;
  const majorConditionPresent = nextDrivers.some(
    (driver) =>
      driver.category === 'medical' &&
      ['medical.cardiovascularDisease', 'medical.cancerHistory', 'medical.chronicKidneyDisease', 'medical.diabetes'].includes(
        driver.id
      )
  );

  nextDrivers.forEach((driver) => {
    let factor = 1;

    if (driver.category === 'lifestyle') {
      factor *= shrinkage.globalLifestyle;
    }

    if (majorConditionPresent && driver.category === 'lifestyle') {
      factor *= shrinkage.diseaseLifestyleWhenMajorCondition;
    }

    const sameGroup = nextDrivers.filter(
      (candidate) => candidate !== driver && candidate.correlationGroup === driver.correlationGroup
    );

    if (sameGroup.length > 0) {
      if (driver.correlationGroup === 'metabolic') {
        factor *= shrinkage.metabolicGroup;
      } else if (driver.correlationGroup === 'respiratory') {
        factor *= shrinkage.respiratoryGroup;
      } else if (driver.correlationGroup === 'diet' || driver.correlationGroup === 'alcohol') {
        factor *= shrinkage.dietGroup;
      } else if (driver.correlationGroup === 'family-history') {
        factor *= shrinkage.familyHistoryGroup;
      }
    }

    driver.adjustedLogHazard = driver.rawLogHazard * factor;
  });

  const unclampedTotal = nextDrivers.reduce((sum, driver) => sum + driver.adjustedLogHazard, 0);
  const clampBand =
    currentAgeYears < 40 ? clampBands.under40 : currentAgeYears < 60 ? clampBands.age40to59 : clampBands.age60plus;
  const clampedTotal = clamp(unclampedTotal, clampBand.min, clampBand.max);

  if (clampedTotal !== unclampedTotal && unclampedTotal !== 0) {
    const scaling = clampedTotal / unclampedTotal;
    nextDrivers.forEach((driver) => {
      driver.adjustedLogHazard *= scaling;
    });
  }

  return {
    totalLogHazard: nextDrivers.reduce((sum, driver) => sum + driver.adjustedLogHazard, 0),
    drivers: nextDrivers
  };
}

function buildDrivers(answers: LongevitySurveyAnswers, dataset: LongevityDataset) {
  const { coefficients } = dataset;
  const drivers: HazardAdjustmentRule[] = [];
  const bmi = computeBodyMassIndex(answers.heightInches, answers.weightPounds);
  const activityMinutes = answers.moderateMinutesPerWeek + answers.vigorousMinutesPerWeek * 2;

  const bmiBand = findRangeBand(coefficients.bmiBands, bmi);
  if (bmiBand.logHazard !== 0) {
    drivers.push(createDriver('lifestyle.bmi', bmiBand.label, 'lifestyle', 'metabolic', bmiBand.logHazard, bmiBand.sourceIds));
  }

  const activityBand = findRangeBand(coefficients.activityBands, activityMinutes);
  if (activityBand.logHazard !== 0) {
    drivers.push(
      createDriver('lifestyle.activity', activityBand.label, 'lifestyle', 'metabolic', activityBand.logHazard, activityBand.sourceIds)
    );
  }

  const strengthBand = findRangeBand(coefficients.strengthBands, answers.strengthDaysPerWeek);
  if (strengthBand.logHazard !== 0) {
    drivers.push(
      createDriver('lifestyle.strength', strengthBand.label, 'lifestyle', 'metabolic', strengthBand.logHazard, strengthBand.sourceIds)
    );
  }

  const sedentaryBand = findRangeBand(coefficients.sedentaryBands, answers.sedentaryHoursPerDay);
  if (sedentaryBand.logHazard !== 0) {
    drivers.push(
      createDriver('lifestyle.sedentary', sedentaryBand.label, 'lifestyle', 'metabolic', sedentaryBand.logHazard, sedentaryBand.sourceIds)
    );
  }

  const sleepBand = findRangeBand(coefficients.sleepBands, answers.sleepHoursPerNight);
  if (sleepBand.logHazard !== 0) {
    drivers.push(createDriver('lifestyle.sleep', sleepBand.label, 'lifestyle', 'respiratory', sleepBand.logHazard, sleepBand.sourceIds));
  }

  const upfBand = coefficients.upfBands.find((band) => band.id === answers.ultraProcessedFoodShare);
  if (upfBand && upfBand.logHazard !== 0) {
    drivers.push(createDriver('lifestyle.upf', upfBand.label, 'lifestyle', 'diet', upfBand.logHazard, upfBand.sourceIds));
  }

  const produceBand = findRangeBand(coefficients.produceBands, answers.fruitVegetableServingsPerDay);
  if (produceBand.logHazard !== 0) {
    drivers.push(
      createDriver('lifestyle.produce', produceBand.label, 'lifestyle', 'diet', produceBand.logHazard, produceBand.sourceIds)
    );
  }

  if (answers.smokingStatus === 'former') {
    const formerBand = findRangeBand(coefficients.smoking.former, answers.yearsSinceQuit ?? 0);
    drivers.push(
      createDriver('lifestyle.smoking.former', formerBand.label, 'lifestyle', 'respiratory', formerBand.logHazard, formerBand.sourceIds)
    );
  } else if (answers.smokingStatus !== 'never') {
    const currentSmoking = coefficients.smoking.current[answers.smokingStatus];
    drivers.push(
      createDriver(
        `lifestyle.smoking.${answers.smokingStatus}`,
        currentSmoking.label,
        'lifestyle',
        'respiratory',
        currentSmoking.logHazard,
        currentSmoking.sourceIds
      )
    );
  }

  const alcoholBand = findRangeBand(coefficients.alcohol.weeklyBands, answers.drinksPerWeek);
  if (alcoholBand.logHazard !== 0) {
    drivers.push(
      createDriver('lifestyle.alcohol.weekly', alcoholBand.label, 'lifestyle', 'alcohol', alcoholBand.logHazard, alcoholBand.sourceIds)
    );
  }

  const bingeBand = coefficients.alcohol.bingeBands.find((band) => band.id === answers.bingeFrequency);
  if (bingeBand && bingeBand.logHazard !== 0) {
    drivers.push(
      createDriver('lifestyle.alcohol.binge', bingeBand.label, 'lifestyle', 'alcohol', bingeBand.logHazard, bingeBand.sourceIds)
    );
  }

  if (answers.systolicBloodPressure !== null) {
    const systolicBand = findRangeBand(coefficients.clinical.systolicBloodPressureBands, answers.systolicBloodPressure);
    if (systolicBand.logHazard !== 0) {
      drivers.push(
        createDriver(
          'clinical.bloodPressure.systolic',
          systolicBand.label,
          'medical',
          'metabolic',
          systolicBand.logHazard,
          systolicBand.sourceIds
        )
      );
    }
  }

  if (answers.diastolicBloodPressure !== null) {
    const diastolicBand = findRangeBand(coefficients.clinical.diastolicBloodPressureBands, answers.diastolicBloodPressure);
    if (diastolicBand.logHazard !== 0) {
      drivers.push(
        createDriver(
          'clinical.bloodPressure.diastolic',
          diastolicBand.label,
          'medical',
          'metabolic',
          diastolicBand.logHazard,
          diastolicBand.sourceIds
        )
      );
    }
  }

  if (answers.usesBloodPressureMedication) {
    const factor = coefficients.clinical.medicationMarkers.bloodPressureMedication;
    drivers.push(
      createDriver('clinical.bloodPressure.medication', factor.label, 'medical', 'metabolic', factor.logHazard, factor.sourceIds)
    );
  }

  if (hasMeasuredCholesterol(answers)) {
    const totalCholesterol = answers.totalCholesterol ?? 0;
    const hdlCholesterol = answers.hdlCholesterol ?? 1;
    const cholesterolRatio = totalCholesterol / hdlCholesterol;
    const cholesterolBand = findRangeBand(coefficients.clinical.cholesterolRatioBands, cholesterolRatio);
    if (cholesterolBand.logHazard !== 0) {
      drivers.push(
        createDriver(
          'clinical.cholesterol.ratio',
          cholesterolBand.label,
          'medical',
          'metabolic',
          cholesterolBand.logHazard,
          cholesterolBand.sourceIds
        )
      );
    }
  }

  if (answers.usesLipidMedication) {
    const factor = coefficients.clinical.medicationMarkers.lipidMedication;
    drivers.push(createDriver('clinical.cholesterol.medication', factor.label, 'medical', 'metabolic', factor.logHazard, factor.sourceIds));
  }

  if (answers.restingHeartRate !== null) {
    const heartRateBand = findRangeBand(coefficients.clinical.restingHeartRateBands, answers.restingHeartRate);
    if (heartRateBand.logHazard !== 0) {
      drivers.push(
        createDriver(
          'clinical.restingHeartRate',
          heartRateBand.label,
          'medical',
          'metabolic',
          heartRateBand.logHazard,
          heartRateBand.sourceIds
        )
      );
    }
  }

  if (answers.hasHypertension && !hasMeasuredBloodPressure(answers) && !answers.usesBloodPressureMedication) {
    const factor = coefficients.medical.hypertension;
    drivers.push(createDriver('medical.hypertension', factor.label, 'medical', 'metabolic', factor.logHazard, factor.sourceIds));
  }

  if (answers.diabetesStatus === 'prediabetes') {
    const factor = coefficients.medical.prediabetes;
    drivers.push(createDriver('medical.prediabetes', factor.label, 'medical', 'metabolic', factor.logHazard, factor.sourceIds));
  } else if (answers.diabetesStatus === 'diabetes') {
    const factor = coefficients.medical.diabetes;
    drivers.push(createDriver('medical.diabetes', factor.label, 'medical', 'metabolic', factor.logHazard, factor.sourceIds));
  }

  if (answers.hasCardiovascularDisease) {
    const factor = coefficients.medical.cardiovascularDisease;
    drivers.push(createDriver('medical.cardiovascularDisease', factor.label, 'medical', 'none', factor.logHazard, factor.sourceIds));
  }

  if (answers.hasCancerHistory) {
    const factor = coefficients.medical.cancerHistory;
    drivers.push(createDriver('medical.cancerHistory', factor.label, 'medical', 'none', factor.logHazard, factor.sourceIds));
  }

  if (answers.hasCopdOrAsthma) {
    const factor = coefficients.medical.copdOrAsthma;
    drivers.push(createDriver('medical.copdOrAsthma', factor.label, 'medical', 'respiratory', factor.logHazard, factor.sourceIds));
  }

  if (answers.hasChronicKidneyDisease) {
    const factor = coefficients.medical.chronicKidneyDisease;
    drivers.push(
      createDriver('medical.chronicKidneyDisease', factor.label, 'medical', 'none', factor.logHazard, factor.sourceIds)
    );
  }

  if (answers.hasSleepApnea) {
    const factor = coefficients.medical.sleepApnea;
    drivers.push(createDriver('medical.sleepApnea', factor.label, 'medical', 'respiratory', factor.logHazard, factor.sourceIds));
  }

  if (answers.hasEarlyFamilyCardioHistory) {
    const factor = coefficients.familyHistory.earlyCardioEvent;
    drivers.push(
      createDriver('family.earlyCardioEvent', factor.label, 'family-history', 'family-history', factor.logHazard, factor.sourceIds)
    );
  }

  const longevityBand = coefficients.familyHistory.parentLongevityBands.find(
    (band) => band.id === answers.parentLongevityBand
  );
  if (longevityBand && longevityBand.logHazard !== 0) {
    drivers.push(
      createDriver('family.parentLongevity', longevityBand.label, 'family-history', 'family-history', longevityBand.logHazard, longevityBand.sourceIds)
    );
  }

  return {
    bmi,
    activityMinutes,
    drivers
  };
}

function captureSurvivalAtHorizon(
  nowTimestamp: number,
  dayOffset: number,
  cumulativeSurvival: number,
  nextTargetIndex: number,
  targetDayOffsets: number[],
  values: number[]
) {
  let index = nextTargetIndex;
  while (index < targetDayOffsets.length && dayOffset >= targetDayOffsets[index]) {
    values[index] = cumulativeSurvival;
    index += 1;
  }
  return index;
}

function projectSurvivalCurve(
  baselineEntries: MortalityBaselineEntry[],
  currentAgeYears: number,
  dataset: LongevityDataset,
  nowTimestamp: number,
  hazardMultiplier: number
) {
  const targetDayOffsets = [5, 10, 20].map((years) => Math.round(years * DAYS_PER_YEAR));
  const survivalValues = [1, 1, 1];
  let survivalTargetIndex = 0;

  const percentiles: Partial<Record<keyof typeof SURVIVAL_PERCENTILES, number>> = {};
  let cumulativeSurvival = 1;
  let medianProjectionFactor = 1;
  const maxDays = Math.round(Math.max(1, (121 - currentAgeYears) * DAYS_PER_YEAR));

  for (let day = 1; day <= maxDays; day += 1) {
    const ageAtDay = currentAgeYears + (day - 0.5) / DAYS_PER_YEAR;
    const baselineHazard = interpolateAnnualHazard(baselineEntries, ageAtDay);
    const projectedTimestamp = nowTimestamp + day * MS_PER_DAY;
    const projectionFactor = computeMortalityProjectionFactor(
      dataset.mortalityProjection,
      new Date(projectedTimestamp).getUTCFullYear(),
      ageAtDay
    );
    const annualHazard = baselineHazard * projectionFactor * hazardMultiplier;
    cumulativeSurvival *= Math.exp(-annualHazard / DAYS_PER_YEAR);

    survivalTargetIndex = captureSurvivalAtHorizon(
      nowTimestamp,
      day,
      cumulativeSurvival,
      survivalTargetIndex,
      targetDayOffsets,
      survivalValues
    );

    for (const [percentile, targetSurvival] of Object.entries(SURVIVAL_PERCENTILES) as Array<
      [keyof typeof SURVIVAL_PERCENTILES, number]
    >) {
      if (!(percentile in percentiles) && cumulativeSurvival <= targetSurvival) {
        percentiles[percentile] = projectedTimestamp;
        if (percentile === 'p50') {
          medianProjectionFactor = projectionFactor;
        }
      }
    }

    if (Object.keys(percentiles).length === 5 && survivalTargetIndex >= targetDayOffsets.length) {
      break;
    }
  }

  if (!percentiles.p50 || !percentiles.p10 || !percentiles.p25 || !percentiles.p75 || !percentiles.p90) {
    throw new Error('The survival model did not converge to all percentile thresholds.');
  }

  return {
    medianTimestamp: percentiles.p50,
    percentileTimestamps: {
      p10: percentiles.p10,
      p25: percentiles.p25,
      p50: percentiles.p50,
      p75: percentiles.p75,
      p90: percentiles.p90
    },
    survivalProbabilities: {
      years5: survivalValues[0],
      years10: survivalValues[1],
      years20: survivalValues[2]
    },
    medianProjectionFactor
  };
}

function buildImpactBreakdown(
  drivers: HazardAdjustmentRule[],
  baselineEntries: MortalityBaselineEntry[],
  currentAgeYears: number,
  dataset: LongevityDataset,
  nowTimestamp: number,
  medianTimestamp: number,
  totalLogHazard: number
): LongevityImpactRow[] {
  return drivers
    .map((driver) => {
      const counterfactualMultiplier = Math.exp(totalLogHazard - driver.adjustedLogHazard);
      const counterfactual = projectSurvivalCurve(
        baselineEntries,
        currentAgeYears,
        dataset,
        nowTimestamp,
        counterfactualMultiplier
      );
      const impactYears = (medianTimestamp - counterfactual.medianTimestamp) / (DAYS_PER_YEAR * MS_PER_DAY);

      return {
        driverId: driver.id,
        label: driver.label,
        category: driver.category,
        direction: (impactYears >= 0 ? 'later' : 'earlier') as LongevityImpactRow['direction'],
        years: Math.abs(impactYears),
        adjustedLogHazard: driver.adjustedLogHazard,
        sourceIds: driver.sourceIds
      };
    })
    .filter((row) => row.years >= 0.05)
    .sort((left, right) => Math.abs(right.years) - Math.abs(left.years))
    .slice(0, 8);
}

export function predictLongevity(
  answers: LongevitySurveyAnswers,
  dataset: LongevityDataset,
  now: Date = new Date()
): PredictionResult {
  const birthDate = parseBirthDateUtc(answers.birthDate);
  const nowTimestamp = now.getTime();
  if (birthDate.getTime() >= nowTimestamp) {
    throw new Error('Birth date must be in the past.');
  }

  const currentAgeYears = (nowTimestamp - birthDate.getTime()) / (DAYS_PER_YEAR * MS_PER_DAY);
  if (currentAgeYears < 18) {
    throw new Error('Death Calculator v1 only supports adults 18 and older.');
  }

  const baselineEntries = dataset.baselines[answers.sex];
  const baselineRemainingLifeExpectancy = interpolateRemainingLifeExpectancy(baselineEntries, currentAgeYears);
  const { drivers } = buildDrivers(answers, dataset);
  const adjusted = applyCorrelationShrinkage(drivers, currentAgeYears, dataset);
  const hazardMultiplier = Math.exp(adjusted.totalLogHazard);

  const projected = projectSurvivalCurve(baselineEntries, currentAgeYears, dataset, nowTimestamp, hazardMultiplier);
  const medianTimestamp = projected.medianTimestamp;
  const driverBreakdown = adjusted.drivers.sort((left, right) => Math.abs(right.adjustedLogHazard) - Math.abs(left.adjustedLogHazard));
  return {
    medianTimestamp,
    percentileTimestamps: projected.percentileTimestamps,
    projectedRange: {
      central: {
        lowerTimestamp: projected.percentileTimestamps.p25,
        upperTimestamp: projected.percentileTimestamps.p75
      },
      wide: {
        lowerTimestamp: projected.percentileTimestamps.p10,
        upperTimestamp: projected.percentileTimestamps.p90
      }
    },
    survivalProbabilities: projected.survivalProbabilities,
    driverBreakdown,
    impactBreakdown: buildImpactBreakdown(
      driverBreakdown,
      baselineEntries,
      currentAgeYears,
      dataset,
      nowTimestamp,
      medianTimestamp,
      adjusted.totalLogHazard
    ),
    dataVersion: dataset.dataVersion,
    baselineYear: dataset.baselineYear,
    totalLogHazard: adjusted.totalLogHazard,
    totalHazardMultiplier: hazardMultiplier,
    currentAgeYears,
    estimatedYearsRemaining: (medianTimestamp - nowTimestamp) / (DAYS_PER_YEAR * MS_PER_DAY),
    baselineRemainingLifeExpectancy,
    projectionId: dataset.mortalityProjection.id,
    projectionLabel: dataset.mortalityProjection.label,
    projectedBaselineAdjustment: projected.medianProjectionFactor,
    modelDisclaimer:
      'This is an actuarial model estimate built from U.S. life tables, mortality-improvement projections, and curated public-health evidence. It is not a medical diagnosis and it cannot identify a true personal outcome with certainty.',
    modelDetails: {
      dataVersion: dataset.dataVersion,
      generatedAt: dataset.generatedAt,
      methodologyVersion: dataset.methodologyVersion,
      baselineYear: dataset.baselineYear,
      baselineSourceIds: dataset.baselineSourceIds,
      projectionId: dataset.mortalityProjection.id,
      projectionLabel: dataset.mortalityProjection.label,
      sources: dataset.sources
    }
  };
}

function addUtcYears(date: Date, years: number) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear() + years,
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
}

export function formatCountdown(targetTimestamp: number, nowTimestamp: number = Date.now()) {
  if (targetTimestamp <= nowTimestamp) {
    return {
      expired: true,
      years: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0
    };
  }

  const target = new Date(targetTimestamp);
  const now = new Date(nowTimestamp);
  let years = target.getUTCFullYear() - now.getUTCFullYear();
  let anchor = addUtcYears(now, years);
  if (anchor.getTime() > target.getTime()) {
    years -= 1;
    anchor = addUtcYears(now, years);
  }

  let remainingMs = target.getTime() - anchor.getTime();
  const days = Math.floor(remainingMs / MS_PER_DAY);
  remainingMs -= days * MS_PER_DAY;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  remainingMs -= hours * 60 * 60 * 1000;
  const minutes = Math.floor(remainingMs / (60 * 1000));
  remainingMs -= minutes * 60 * 1000;
  const seconds = Math.floor(remainingMs / 1000);

  return {
    expired: false,
    years,
    days,
    hours,
    minutes,
    seconds
  };
}

export function formatCountdownDisplay(targetTimestamp: number, nowTimestamp: number = Date.now()) {
  const countdown = formatCountdown(targetTimestamp, nowTimestamp);

  return [
    String(countdown.years).padStart(2, '0'),
    String(countdown.days).padStart(3, '0'),
    String(countdown.hours).padStart(2, '0'),
    String(countdown.minutes).padStart(2, '0'),
    String(countdown.seconds).padStart(2, '0')
  ].join(':');
}

export function formatPredictionDate(timestamp: number) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(new Date(timestamp));
}

export function formatProbability(probability: number) {
  return `${(probability * 100).toFixed(1)}%`;
}
