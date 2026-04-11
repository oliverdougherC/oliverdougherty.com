#!/usr/bin/env node

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'utilities-src', 'src', 'data', 'longevity-dataset.json');
const RETRIEVED_AT = new Date().toISOString();
const LIFE_TABLE_DIRECTORY =
  'https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/NVSR/74-06';

const SOURCE_DEFINITIONS = [
  {
    id: 'cdc-life-expectancy-2023-overview',
    url: 'https://www.cdc.gov/nchs/nvss/life-expectancy.htm',
    evidenceGrade: 'official-statistical-baseline',
    fallbackTitle: 'Life Expectancy | CDC',
    fallbackPublishedDate: '2025-07-15',
    notes:
      'Used to identify the latest published U.S. life-table release and the CDC download structure for annual Excel tables.'
  },
  {
    id: 'cdc-life-table-2023-male',
    url: `${LIFE_TABLE_DIRECTORY}/Table02.xlsx`,
    evidenceGrade: 'official-statistical-baseline',
    notes: 'Table 2 contains the male 2023 U.S. period life table used for baseline male annual death probabilities.'
  },
  {
    id: 'cdc-life-table-2023-female',
    url: `${LIFE_TABLE_DIRECTORY}/Table03.xlsx`,
    evidenceGrade: 'official-statistical-baseline',
    notes: 'Table 3 contains the female 2023 U.S. period life table used for baseline female annual death probabilities.'
  },
  {
    id: 'cdc-mortality-2022-brief',
    url: 'https://www.cdc.gov/nchs/products/databriefs/db492.htm',
    evidenceGrade: 'official-context',
    fallbackTitle: 'Mortality in the United States, 2022',
    fallbackPublishedDate: '2024-03-21',
    notes:
      'Provides U.S. mortality and life-expectancy context used in the methodology drawer and for baseline sanity checks.'
  },
  {
    id: 'who-physical-activity-guidelines',
    url: 'https://www.who.int/publications/i/item/9789240014886',
    evidenceGrade: 'official-guideline',
    fallbackTitle: 'WHO guidelines on physical activity and sedentary behaviour: at a glance',
    fallbackPublishedDate: '2020-11-26',
    notes:
      'Used to center activity questions around guideline-relevant weekly moderate and vigorous activity bands.'
  },
  {
    id: 'cdc-smoking-overview',
    url: 'https://www.cdc.gov/tobacco/about/index.html',
    evidenceGrade: 'official-guideline',
    fallbackTitle: 'Cigarette Smoking | CDC',
    fallbackPublishedDate: '2024-09-17',
    notes:
      'Supports cigarette-smoking health-risk framing and anchors smoking as a major mortality driver.'
  },
  {
    id: 'nhis-light-smoking-cohort',
    url: 'https://pubmed.ncbi.nlm.nih.gov/32679883/',
    evidenceGrade: 'cohort-study',
    fallbackTitle:
      'Light Cigarette Smoking Increases Risk of All-Cause and Cause-Specific Mortality: Findings from the NHIS Cohort Study',
    fallbackPublishedDate: '2020-07-15',
    notes:
      'Used to calibrate current-smoking penalties and to ensure even light daily smoking materially raises mortality risk.'
  },
  {
    id: 'cdc-alcohol-health',
    url: 'https://www.cdc.gov/alcohol/about-alcohol-use/index.html',
    evidenceGrade: 'official-guideline',
    fallbackTitle: 'Alcohol Use and Your Health | CDC',
    fallbackPublishedDate: '2025-01-14',
    notes:
      'Supports alcohol-use question framing and non-protective modeling assumptions for higher weekly use and bingeing.'
  },
  {
    id: 'surgeon-general-alcohol-cancer-advisory',
    url: 'https://www.ncbi.nlm.nih.gov/books/NBK614464/',
    evidenceGrade: 'official-advisory',
    fallbackTitle: 'About This Advisory - Alcohol and Cancer Risk - NCBI Bookshelf',
    fallbackPublishedDate: '2025',
    notes:
      'Supports conservative alcohol-risk modeling and the decision not to treat alcohol as longevity-protective.'
  },
  {
    id: 'cdc-obesity-consequences',
    url: 'https://www.cdc.gov/obesity/php/about/consequences.html',
    evidenceGrade: 'official-guideline',
    fallbackTitle: 'Consequences of Obesity | CDC',
    fallbackPublishedDate: '2025-12-05',
    notes:
      'Supports obesity-related chronic disease linkage used for BMI band penalties and overlap guardrails.'
  },
  {
    id: 'cdc-diabetes-burden-toolkit',
    url: 'https://nccd.cdc.gov/Toolkit/DiabetesBurden/Mortality/DiabetesCauseRate',
    evidenceGrade: 'official-technical',
    fallbackTitle: 'Deaths with Diabetes as Underlying Cause of Death',
    fallbackPublishedDate: '2024-06-01',
    notes:
      'Supports diabetes as a direct all-cause mortality multiplier rather than only a proxy risk factor.'
  },
  {
    id: 'aha-prevent-calculator-overview',
    url: 'https://professional.heart.org/en/guidelines-and-statements/about-prevent-calculator',
    evidenceGrade: 'official-guideline',
    fallbackTitle: 'Predicting Risk of cardiovascular disease EVENTs (American Heart Association PREVENT)',
    fallbackPublishedDate: '2023',
    notes:
      'Anchors the optional clinical-basics question set around cardiovascular, kidney, and metabolic health factors without importing the licensed PREVENT source code.'
  },
  {
    id: 'resting-heart-rate-mortality-meta-analysis',
    url: 'https://pubmed.ncbi.nlm.nih.gov/28552551/',
    evidenceGrade: 'systematic-review',
    fallbackTitle:
      'Resting heart rate and the risk of cardiovascular disease, total cancer, and all-cause mortality - A systematic review and dose-response meta-analysis of prospective studies',
    fallbackPublishedDate: '2017-04-04',
    notes:
      'Supports resting heart rate as an optional clinical marker associated with all-cause and cardiovascular mortality in prospective cohorts.'
  },
  {
    id: 'upf-meta-analysis-2025',
    url: 'https://pubmed.ncbi.nlm.nih.gov/40033461/',
    evidenceGrade: 'systematic-review',
    fallbackTitle:
      'Ultra-processed foods and risk of all-cause mortality: an updated systematic review and dose-response meta-analysis of prospective cohort studies',
    fallbackPublishedDate: '2025-03-03',
    notes:
      'Used to define monotonic ultra-processed-food intake penalties through broad consumption bands.'
  },
  {
    id: 'ssa-trustees-2025-cohort-life-expectancy',
    url: 'https://www.ssa.gov/oact/TR/2025/lr5a5.html',
    evidenceGrade: 'official-actuarial-projection',
    fallbackTitle: 'Cohort Life Expectancy - 2025 OASDI Trustees Report',
    fallbackPublishedDate: '2025',
    notes:
      'Defines SSA cohort life expectancy as projected death rates across the years a person reaches each future age.'
  },
  {
    id: 'ssa-trustees-2025-report',
    url: 'https://www.ssa.gov/oact/TR/2025/tr2025.pdf',
    evidenceGrade: 'official-actuarial-projection',
    fallbackTitle: 'The 2025 Annual Report of the Board of Trustees of the Federal OASDI Trust Funds',
    fallbackPublishedDate: '2025',
    notes:
      'Supports the intermediate mortality-improvement projection used to adjust baseline future-year hazards.'
  }
];

const MORTALITY_PROJECTION = {
  id: 'ssa-trustees-2025-intermediate',
  label: 'SSA Trustees 2025 intermediate mortality improvement',
  startYear: 2024,
  terminalYear: 2099,
  annualImprovementUnder65: 0.0074,
  annualImprovement65Plus: 0.0068,
  sourceIds: ['ssa-trustees-2025-cohort-life-expectancy', 'ssa-trustees-2025-report']
};

const COEFFICIENTS = {
  clamp: {
    under40: { min: -0.55, max: 1.2 },
    age40to59: { min: -0.5, max: 1.05 },
    age60plus: { min: -0.42, max: 0.92 }
  },
  shrinkage: {
    globalLifestyle: 0.92,
    diseaseLifestyleWhenMajorCondition: 0.85,
    metabolicGroup: 0.82,
    respiratoryGroup: 0.9,
    dietGroup: 0.9,
    familyHistoryGroup: 0.95
  },
  bmiBands: [
    { min: 0, max: 18.5, logHazard: 0.16, label: 'Underweight', sourceIds: ['cdc-obesity-consequences'] },
    { min: 18.5, max: 25, logHazard: 0, label: 'Reference weight', sourceIds: ['cdc-obesity-consequences'] },
    { min: 25, max: 30, logHazard: 0.03, label: 'Overweight', sourceIds: ['cdc-obesity-consequences'] },
    { min: 30, max: 35, logHazard: 0.11, label: 'Obesity class I', sourceIds: ['cdc-obesity-consequences'] },
    { min: 35, max: 40, logHazard: 0.22, label: 'Obesity class II', sourceIds: ['cdc-obesity-consequences'] },
    { min: 40, max: 80, logHazard: 0.32, label: 'Obesity class III', sourceIds: ['cdc-obesity-consequences'] }
  ],
  activityBands: [
    { min: 0, max: 1, logHazard: 0.22, label: 'No weekly activity', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 1, max: 75, logHazard: 0.13, label: 'Very low activity', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 75, max: 150, logHazard: 0.05, label: 'Below guideline activity', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 150, max: 300, logHazard: -0.08, label: 'Meets guideline activity', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 300, max: 4000, logHazard: -0.12, label: 'Exceeds guideline activity', sourceIds: ['who-physical-activity-guidelines'] }
  ],
  strengthBands: [
    { min: 0, max: 1, logHazard: 0.03, label: 'No strength work', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 1, max: 3, logHazard: 0, label: 'Some strength work', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 3, max: 8, logHazard: -0.02, label: 'Frequent strength work', sourceIds: ['who-physical-activity-guidelines'] }
  ],
  sedentaryBands: [
    { min: 0, max: 6, logHazard: -0.03, label: 'Low sedentary time', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 6, max: 8.5, logHazard: 0, label: 'Moderate sedentary time', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 8.5, max: 10.5, logHazard: 0.04, label: 'High sedentary time', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 10.5, max: 24, logHazard: 0.08, label: 'Very high sedentary time', sourceIds: ['who-physical-activity-guidelines'] }
  ],
  sleepBands: [
    { min: 0, max: 5, logHazard: 0.18, label: 'Very short sleep', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 5, max: 6, logHazard: 0.08, label: 'Short sleep', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 6, max: 7, logHazard: 0.02, label: 'Slightly short sleep', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 7, max: 9, logHazard: -0.05, label: 'Reference sleep', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 9, max: 10, logHazard: 0.03, label: 'Long sleep', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 10, max: 24, logHazard: 0.16, label: 'Very long sleep', sourceIds: ['who-physical-activity-guidelines'] }
  ],
  upfBands: [
    { id: 'minimal', logHazard: -0.03, label: 'Very low processed-food share', sourceIds: ['upf-meta-analysis-2025'] },
    { id: 'low', logHazard: 0, label: 'Low processed-food share', sourceIds: ['upf-meta-analysis-2025'] },
    { id: 'moderate', logHazard: 0.05, label: 'Moderate processed-food share', sourceIds: ['upf-meta-analysis-2025'] },
    { id: 'high', logHazard: 0.11, label: 'High processed-food share', sourceIds: ['upf-meta-analysis-2025'] },
    { id: 'very-high', logHazard: 0.17, label: 'Very high processed-food share', sourceIds: ['upf-meta-analysis-2025'] }
  ],
  produceBands: [
    { min: 0, max: 2, logHazard: 0.08, label: 'Very low produce intake', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 2, max: 5, logHazard: 0.03, label: 'Low produce intake', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 5, max: 8, logHazard: -0.04, label: 'Good produce intake', sourceIds: ['who-physical-activity-guidelines'] },
    { min: 8, max: 25, logHazard: -0.06, label: 'High produce intake', sourceIds: ['who-physical-activity-guidelines'] }
  ],
  smoking: {
    current: {
      some: { logHazard: 0.24, label: 'Current some-day smoking', sourceIds: ['cdc-smoking-overview', 'nhis-light-smoking-cohort'] },
      light: { logHazard: 0.32, label: 'Current light daily smoking', sourceIds: ['cdc-smoking-overview', 'nhis-light-smoking-cohort'] },
      moderate: { logHazard: 0.5, label: 'Current moderate daily smoking', sourceIds: ['cdc-smoking-overview', 'nhis-light-smoking-cohort'] },
      heavy: { logHazard: 0.72, label: 'Current heavy daily smoking', sourceIds: ['cdc-smoking-overview', 'nhis-light-smoking-cohort'] }
    },
    former: [
      { min: 0, max: 5, logHazard: 0.24, label: 'Recently quit smoking', sourceIds: ['cdc-smoking-overview', 'nhis-light-smoking-cohort'] },
      { min: 5, max: 15, logHazard: 0.14, label: 'Former smoking within 5-15 years', sourceIds: ['cdc-smoking-overview', 'nhis-light-smoking-cohort'] },
      { min: 15, max: 80, logHazard: 0.06, label: 'Former smoking 15+ years ago', sourceIds: ['cdc-smoking-overview', 'nhis-light-smoking-cohort'] }
    ]
  },
  alcohol: {
    weeklyBands: [
      { min: 0, max: 1, logHazard: 0, label: 'No alcohol use', sourceIds: ['cdc-alcohol-health', 'surgeon-general-alcohol-cancer-advisory'] },
      { min: 1, max: 8, logHazard: 0, label: 'Low weekly alcohol use', sourceIds: ['cdc-alcohol-health', 'surgeon-general-alcohol-cancer-advisory'] },
      { min: 8, max: 15, logHazard: 0.05, label: 'Moderate weekly alcohol use', sourceIds: ['cdc-alcohol-health', 'surgeon-general-alcohol-cancer-advisory'] },
      { min: 15, max: 22, logHazard: 0.12, label: 'High weekly alcohol use', sourceIds: ['cdc-alcohol-health', 'surgeon-general-alcohol-cancer-advisory'] },
      { min: 22, max: 80, logHazard: 0.2, label: 'Very high weekly alcohol use', sourceIds: ['cdc-alcohol-health', 'surgeon-general-alcohol-cancer-advisory'] }
    ],
    bingeBands: [
      { id: 'never', logHazard: 0, label: 'No binge drinking', sourceIds: ['cdc-alcohol-health', 'surgeon-general-alcohol-cancer-advisory'] },
      { id: 'monthly', logHazard: 0.05, label: 'Monthly binge drinking', sourceIds: ['cdc-alcohol-health', 'surgeon-general-alcohol-cancer-advisory'] },
      { id: 'weekly', logHazard: 0.12, label: 'Weekly binge drinking', sourceIds: ['cdc-alcohol-health', 'surgeon-general-alcohol-cancer-advisory'] },
      { id: 'multiple-weekly', logHazard: 0.2, label: 'Multiple weekly binge episodes', sourceIds: ['cdc-alcohol-health', 'surgeon-general-alcohol-cancer-advisory'] }
    ]
  },
  clinical: {
    systolicBloodPressureBands: [
      { min: 0, max: 120, logHazard: -0.02, label: 'Optimal systolic blood pressure', sourceIds: ['aha-prevent-calculator-overview'] },
      { min: 120, max: 130, logHazard: 0, label: 'Reference systolic blood pressure', sourceIds: ['aha-prevent-calculator-overview'] },
      { min: 130, max: 140, logHazard: 0.04, label: 'Elevated systolic blood pressure', sourceIds: ['aha-prevent-calculator-overview'] },
      { min: 140, max: 160, logHazard: 0.1, label: 'High systolic blood pressure', sourceIds: ['aha-prevent-calculator-overview'] },
      { min: 160, max: 260, logHazard: 0.18, label: 'Very high systolic blood pressure', sourceIds: ['aha-prevent-calculator-overview'] }
    ],
    diastolicBloodPressureBands: [
      { min: 0, max: 80, logHazard: 0, label: 'Reference diastolic blood pressure', sourceIds: ['aha-prevent-calculator-overview'] },
      { min: 80, max: 90, logHazard: 0.03, label: 'Elevated diastolic blood pressure', sourceIds: ['aha-prevent-calculator-overview'] },
      { min: 90, max: 100, logHazard: 0.08, label: 'High diastolic blood pressure', sourceIds: ['aha-prevent-calculator-overview'] },
      { min: 100, max: 160, logHazard: 0.14, label: 'Very high diastolic blood pressure', sourceIds: ['aha-prevent-calculator-overview'] }
    ],
    cholesterolRatioBands: [
      { min: 0, max: 3.5, logHazard: -0.03, label: 'Favorable total-to-HDL cholesterol ratio', sourceIds: ['aha-prevent-calculator-overview'] },
      { min: 3.5, max: 5, logHazard: 0, label: 'Reference total-to-HDL cholesterol ratio', sourceIds: ['aha-prevent-calculator-overview'] },
      { min: 5, max: 6.5, logHazard: 0.05, label: 'Elevated total-to-HDL cholesterol ratio', sourceIds: ['aha-prevent-calculator-overview'] },
      { min: 6.5, max: 16, logHazard: 0.1, label: 'High total-to-HDL cholesterol ratio', sourceIds: ['aha-prevent-calculator-overview'] }
    ],
    restingHeartRateBands: [
      { min: 0, max: 60, logHazard: -0.02, label: 'Low resting heart rate', sourceIds: ['resting-heart-rate-mortality-meta-analysis'] },
      { min: 60, max: 80, logHazard: 0, label: 'Reference resting heart rate', sourceIds: ['resting-heart-rate-mortality-meta-analysis'] },
      { min: 80, max: 90, logHazard: 0.04, label: 'Elevated resting heart rate', sourceIds: ['resting-heart-rate-mortality-meta-analysis'] },
      { min: 90, max: 110, logHazard: 0.1, label: 'High resting heart rate', sourceIds: ['resting-heart-rate-mortality-meta-analysis'] },
      { min: 110, max: 220, logHazard: 0.16, label: 'Very high resting heart rate', sourceIds: ['resting-heart-rate-mortality-meta-analysis'] }
    ],
    medicationMarkers: {
      bloodPressureMedication: {
        logHazard: 0.04,
        label: 'Blood pressure medication marker',
        sourceIds: ['aha-prevent-calculator-overview']
      },
      lipidMedication: {
        logHazard: 0.03,
        label: 'Lipid medication marker',
        sourceIds: ['aha-prevent-calculator-overview']
      }
    }
  },
  medical: {
    hypertension: { logHazard: 0.11, label: 'Hypertension', sourceIds: ['cdc-obesity-consequences'] },
    prediabetes: { logHazard: 0.06, label: 'Prediabetes', sourceIds: ['cdc-diabetes-burden-toolkit'] },
    diabetes: { logHazard: 0.25, label: 'Diabetes', sourceIds: ['cdc-diabetes-burden-toolkit'] },
    cardiovascularDisease: { logHazard: 0.48, label: 'Prior cardiovascular disease or stroke', sourceIds: ['cdc-mortality-2022-brief'] },
    cancerHistory: { logHazard: 0.34, label: 'Cancer history', sourceIds: ['cdc-mortality-2022-brief'] },
    copdOrAsthma: { logHazard: 0.18, label: 'COPD or chronic asthma', sourceIds: ['cdc-smoking-overview'] },
    chronicKidneyDisease: { logHazard: 0.42, label: 'Chronic kidney disease', sourceIds: ['cdc-obesity-consequences'] },
    sleepApnea: { logHazard: 0.12, label: 'Sleep apnea', sourceIds: ['cdc-obesity-consequences'] }
  },
  familyHistory: {
    earlyCardioEvent: { logHazard: 0.08, label: 'Early family cardiovascular disease', sourceIds: ['cdc-mortality-2022-brief'] },
    parentLongevityBands: [
      { id: 'both-under-75', logHazard: 0.12, label: 'Both parents died before 75', sourceIds: ['cdc-life-expectancy-2023-overview'] },
      { id: 'mixed', logHazard: 0.03, label: 'Mixed parent longevity', sourceIds: ['cdc-life-expectancy-2023-overview'] },
      { id: 'one-85-plus', logHazard: -0.05, label: 'One parent lived past 85', sourceIds: ['cdc-life-expectancy-2023-overview'] },
      { id: 'both-85-plus', logHazard: -0.1, label: 'Both parents lived past 85', sourceIds: ['cdc-life-expectancy-2023-overview'] }
    ]
  }
};

function decodeXmlText(value) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseMeta(content, key) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${key}["']`, 'i')
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return decodeXmlText(match[1]);
    }
  }

  return null;
}

function parseTitle(content) {
  const match = content.match(/<title>\s*([^<]+?)\s*<\/title>/i);
  return match ? decodeXmlText(match[1]) : null;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Oliver-Unified-longevity-data-updater/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

async function fetchArrayBuffer(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Oliver-Unified-longevity-data-updater/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function extractSharedStrings(xml) {
  return Array.from(xml.matchAll(/<si>([\s\S]*?)<\/si>/g), (match) => {
    const parts = Array.from(match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g), (part) => decodeXmlText(part[1]));
    return parts.join('');
  });
}

function extractSheetRows(xml, sharedStrings) {
  const rows = [];

  for (const rowMatch of xml.matchAll(/<row[^>]+r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(rowMatch[1]);
    const cellMap = {};

    for (const cellMatch of rowMatch[2].matchAll(/<c[^>]+r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const column = cellMatch[1];
      const attributes = cellMatch[2];
      const body = cellMatch[3];
      const valueMatch = body.match(/<v>([\s\S]*?)<\/v>/);

      if (!valueMatch) {
        cellMap[column] = null;
        continue;
      }

      const rawValue = valueMatch[1];
      const type = /t="([^"]+)"/.exec(attributes)?.[1] ?? '';
      if (type === 's') {
        cellMap[column] = sharedStrings[Number(rawValue)];
      } else {
        cellMap[column] = Number(rawValue);
      }
    }

    rows.push({ rowNumber, cells: cellMap });
  }

  return rows;
}

function parseAgeLabel(label) {
  if (label === '100 and over' || label === '100 and older') {
    return { age: 100, label };
  }

  const match = label.match(/^(\d+)–(\d+)$/);
  if (!match) {
    throw new Error(`Unrecognized age label: ${label}`);
  }

  return { age: Number(match[1]), label };
}

async function extractXlsxXml(fileBuffer, innerPath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'longevity-data-'));
  const filePath = path.join(tempDir, 'table.xlsx');
  await fs.writeFile(filePath, fileBuffer);

  try {
    const { stdout } = await execFileAsync('unzip', ['-p', filePath, innerPath], {
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function loadLifeTable(url, sex) {
  const buffer = await fetchArrayBuffer(url);
  const [sharedStringsXml, sheetXml] = await Promise.all([
    extractXlsxXml(buffer, 'xl/sharedStrings.xml'),
    extractXlsxXml(buffer, 'xl/worksheets/sheet1.xml')
  ]);

  const sharedStrings = extractSharedStrings(sharedStringsXml);
  const rows = extractSheetRows(sheetXml, sharedStrings);
  const title = sharedStrings.find((value) => /United States,\s*\d{4}/.test(value)) ?? sharedStrings[2];
  const yearMatch = title.match(/(\d{4})$/);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  const entries = rows
    .filter((row) => row.rowNumber >= 4 && row.cells.A && typeof row.cells.B === 'number')
    .map((row) => {
      const ageInfo = parseAgeLabel(row.cells.A);
      return {
        age: ageInfo.age,
        label: ageInfo.label,
        qx: Number(row.cells.B),
        lx: Number(row.cells.C),
        dx: Number(row.cells.D),
        Lx: Number(row.cells.E),
        Tx: Number(row.cells.F),
        ex: Number(row.cells.G)
      };
    });

  return {
    sex,
    title,
    year,
    entries
  };
}

async function resolveSourceMetadata(source) {
  if (source.url.endsWith('.xlsx')) {
    return {
      id: source.id,
      title: source.id === 'cdc-life-table-2023-male' ? 'Table 2. Life table for males: United States, 2023' : 'Table 3. Life table for females: United States, 2023',
      url: source.url,
      publishedDate: '2025-06-20',
      retrievedAt: RETRIEVED_AT,
      evidenceGrade: source.evidenceGrade,
      notes: source.notes
    };
  }

  let content = null;
  try {
    content = await fetchText(source.url);
  } catch (error) {
    if (!source.fallbackTitle) {
      throw error;
    }
  }

  const title =
    (content &&
      (parseMeta(content, 'citation_title') ||
        parseMeta(content, 'og:title') ||
        parseTitle(content))) ||
    source.fallbackTitle ||
    source.id;
  const publishedDate =
    (content &&
      (parseMeta(content, 'citation_date') ||
        parseMeta(content, 'cdc:last_updated') ||
        parseMeta(content, 'cdc:first_published') ||
        parseMeta(content, 'DC.date'))) ||
    source.fallbackPublishedDate ||
    null;

  return {
    id: source.id,
    title,
    url: source.url,
    publishedDate,
    retrievedAt: RETRIEVED_AT,
    evidenceGrade: source.evidenceGrade,
    notes: source.notes
  };
}

async function buildDataset() {
  const [maleTable, femaleTable, sources] = await Promise.all([
    loadLifeTable(`${LIFE_TABLE_DIRECTORY}/Table02.xlsx`, 'male'),
    loadLifeTable(`${LIFE_TABLE_DIRECTORY}/Table03.xlsx`, 'female'),
    Promise.all(SOURCE_DEFINITIONS.map((source) => resolveSourceMetadata(source)))
  ]);

  return {
    dataVersion: `us-longevity-v1-${maleTable.year}`,
    generatedAt: RETRIEVED_AT,
    localeScope: 'US',
    methodologyVersion: 1,
    baselineYear: maleTable.year,
    baselineSourceIds: ['cdc-life-table-2023-male', 'cdc-life-table-2023-female'],
    sources,
    baselines: {
      male: maleTable.entries,
      female: femaleTable.entries
    },
    mortalityProjection: MORTALITY_PROJECTION,
    coefficients: COEFFICIENTS
  };
}

async function main() {
  const dataset = await buildDataset();
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(dataset, null, 2)}\n`);
  process.stdout.write(`Updated ${path.relative(ROOT, OUTPUT_PATH)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
