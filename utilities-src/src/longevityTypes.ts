export type ActuarialSex = 'male' | 'female';
export type SmokingStatus = 'never' | 'former' | 'some' | 'light' | 'moderate' | 'heavy';
export type DiabetesStatus = 'none' | 'prediabetes' | 'diabetes';
export type UltraProcessedFoodShare = 'minimal' | 'low' | 'moderate' | 'high' | 'very-high';
export type BingeFrequency = 'never' | 'monthly' | 'weekly' | 'multiple-weekly';
export type ParentLongevityBand = 'both-under-75' | 'mixed' | 'one-85-plus' | 'both-85-plus';
export type EvidenceGrade =
  | 'official-statistical-baseline'
  | 'official-context'
  | 'official-guideline'
  | 'official-advisory'
  | 'official-technical'
  | 'official-actuarial-projection'
  | 'cohort-study'
  | 'systematic-review';
export type HazardCategory = 'baseline' | 'lifestyle' | 'medical' | 'family-history';
export type CorrelationGroup = 'metabolic' | 'diet' | 'respiratory' | 'family-history' | 'alcohol' | 'none';

export interface LongevitySurveyAnswers {
  birthDate: string;
  sex: ActuarialSex;
  heightInches: number;
  weightPounds: number;
  moderateMinutesPerWeek: number;
  vigorousMinutesPerWeek: number;
  strengthDaysPerWeek: number;
  sedentaryHoursPerDay: number;
  smokingStatus: SmokingStatus;
  yearsSinceQuit: number | null;
  drinksPerWeek: number;
  bingeFrequency: BingeFrequency;
  sleepHoursPerNight: number;
  ultraProcessedFoodShare: UltraProcessedFoodShare;
  fruitVegetableServingsPerDay: number;
  systolicBloodPressure: number | null;
  diastolicBloodPressure: number | null;
  usesBloodPressureMedication: boolean;
  totalCholesterol: number | null;
  hdlCholesterol: number | null;
  usesLipidMedication: boolean;
  restingHeartRate: number | null;
  hasHypertension: boolean;
  diabetesStatus: DiabetesStatus;
  hasCardiovascularDisease: boolean;
  hasCancerHistory: boolean;
  hasCopdOrAsthma: boolean;
  hasChronicKidneyDisease: boolean;
  hasSleepApnea: boolean;
  hasEarlyFamilyCardioHistory: boolean;
  parentLongevityBand: ParentLongevityBand;
}

export interface EvidenceSource {
  id: string;
  title: string;
  url: string;
  publishedDate: string | null;
  retrievedAt: string;
  evidenceGrade: EvidenceGrade;
  notes: string;
}

export interface MortalityBaselineEntry {
  age: number;
  label: string;
  qx: number;
  lx: number;
  dx: number;
  Lx: number;
  Tx: number;
  ex: number;
}

export interface MortalityBaselineTable {
  male: MortalityBaselineEntry[];
  female: MortalityBaselineEntry[];
}

export interface ClampBand {
  min: number;
  max: number;
}

export interface RangeHazardBand {
  min: number;
  max: number;
  logHazard: number;
  label: string;
  sourceIds: string[];
}

export interface DiscreteHazardBand {
  id: string;
  logHazard: number;
  label: string;
  sourceIds: string[];
}

export interface RiskFactorDefinition {
  clamp: {
    under40: ClampBand;
    age40to59: ClampBand;
    age60plus: ClampBand;
  };
  shrinkage: {
    globalLifestyle: number;
    diseaseLifestyleWhenMajorCondition: number;
    metabolicGroup: number;
    respiratoryGroup: number;
    dietGroup: number;
    familyHistoryGroup: number;
  };
  bmiBands: RangeHazardBand[];
  activityBands: RangeHazardBand[];
  strengthBands: RangeHazardBand[];
  sedentaryBands: RangeHazardBand[];
  sleepBands: RangeHazardBand[];
  upfBands: DiscreteHazardBand[];
  produceBands: RangeHazardBand[];
  smoking: {
    current: Record<'some' | 'light' | 'moderate' | 'heavy', DiscreteHazardBand>;
    former: RangeHazardBand[];
  };
  alcohol: {
    weeklyBands: RangeHazardBand[];
    bingeBands: DiscreteHazardBand[];
  };
  clinical: {
    systolicBloodPressureBands: RangeHazardBand[];
    diastolicBloodPressureBands: RangeHazardBand[];
    cholesterolRatioBands: RangeHazardBand[];
    restingHeartRateBands: RangeHazardBand[];
    medicationMarkers: Record<
      'bloodPressureMedication' | 'lipidMedication',
      {
        logHazard: number;
        label: string;
        sourceIds: string[];
      }
    >;
  };
  medical: Record<
    | 'hypertension'
    | 'prediabetes'
    | 'diabetes'
    | 'cardiovascularDisease'
    | 'cancerHistory'
    | 'copdOrAsthma'
    | 'chronicKidneyDisease'
    | 'sleepApnea',
    {
      logHazard: number;
      label: string;
      sourceIds: string[];
    }
  >;
  familyHistory: {
    earlyCardioEvent: {
      logHazard: number;
      label: string;
      sourceIds: string[];
    };
    parentLongevityBands: DiscreteHazardBand[];
  };
}

export interface HazardAdjustmentRule {
  id: string;
  label: string;
  category: HazardCategory;
  correlationGroup: CorrelationGroup;
  rawLogHazard: number;
  adjustedLogHazard: number;
  sourceIds: string[];
}

export interface SurvivalProbabilities {
  years5: number;
  years10: number;
  years20: number;
}

export interface ProjectedRange {
  central: {
    lowerTimestamp: number;
    upperTimestamp: number;
  };
  wide: {
    lowerTimestamp: number;
    upperTimestamp: number;
  };
}

export interface LongevityImpactRow {
  driverId: string;
  label: string;
  category: HazardCategory;
  direction: 'earlier' | 'later';
  years: number;
  adjustedLogHazard: number;
  sourceIds: string[];
}

export interface MortalityProjectionConfig {
  id: string;
  label: string;
  startYear: number;
  terminalYear: number;
  annualImprovementUnder65: number;
  annualImprovement65Plus: number;
  sourceIds: string[];
}

export interface PredictionResult {
  medianTimestamp: number;
  percentileTimestamps: Record<'p10' | 'p25' | 'p50' | 'p75' | 'p90', number>;
  projectedRange: ProjectedRange;
  survivalProbabilities: SurvivalProbabilities;
  driverBreakdown: HazardAdjustmentRule[];
  impactBreakdown: LongevityImpactRow[];
  dataVersion: string;
  baselineYear: number;
  totalLogHazard: number;
  totalHazardMultiplier: number;
  currentAgeYears: number;
  estimatedYearsRemaining: number;
  baselineRemainingLifeExpectancy: number;
  projectionId: string;
  projectionLabel: string;
  projectedBaselineAdjustment: number;
  modelDisclaimer: string;
  modelDetails: {
    dataVersion: string;
    generatedAt: string;
    methodologyVersion: number;
    baselineYear: number;
    baselineSourceIds: string[];
    projectionId: string;
    projectionLabel: string;
    sources: EvidenceSource[];
  };
}

export interface LongevityDataset {
  dataVersion: string;
  generatedAt: string;
  localeScope: 'US';
  methodologyVersion: number;
  baselineYear: number;
  baselineSourceIds: string[];
  sources: EvidenceSource[];
  baselines: MortalityBaselineTable;
  mortalityProjection: MortalityProjectionConfig;
  coefficients: RiskFactorDefinition;
}
