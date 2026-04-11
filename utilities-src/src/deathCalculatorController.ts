import { longevityDataset } from './longevityDataset';
import {
  formatCountdownDisplay,
  formatPredictionDate,
  predictLongevity
} from './longevityEngine';
import type { LongevitySurveyAnswers, PredictionResult, SmokingStatus } from './longevityTypes';

type DeathCalculatorScreen = 'intro' | 'question' | 'processing' | 'result' | 'error';

interface QuestionDefinition {
  id: string;
  controls: string[];
  eyebrow: string;
  title: string;
  isVisible?: (controller: DeathCalculatorController) => boolean;
}

const QUESTION_DEFINITIONS: QuestionDefinition[] = [
  {
    id: 'birthDate',
    controls: ['deathBirthDate'],
    eyebrow: 'Demographics 01',
    title: 'When were you born?'
  },
  {
    id: 'sex',
    controls: ['deathSex'],
    eyebrow: 'Demographics 02',
    title: 'Which actuarial baseline should the model use?'
  },
  {
    id: 'weight',
    controls: ['deathWeightPounds'],
    eyebrow: 'Body Composition 03',
    title: 'What is your weight?'
  },
  {
    id: 'height',
    controls: ['deathHeightFeet', 'deathHeightInchesPart'],
    eyebrow: 'Body Composition 04',
    title: 'How tall are you?'
  },
  {
    id: 'moderateMinutes',
    controls: ['deathModerateDays', 'deathModerateMinutesSession'],
    eyebrow: 'Activity 05',
    title: 'How much moderate activity do you get?'
  },
  {
    id: 'vigorousMinutes',
    controls: ['deathVigorousDays', 'deathVigorousMinutesSession'],
    eyebrow: 'Activity 06',
    title: 'How much vigorous activity do you get?'
  },
  {
    id: 'strengthDays',
    controls: ['deathStrengthDays'],
    eyebrow: 'Activity 07',
    title: 'How many days per week do you do strength training?'
  },
  {
    id: 'sedentaryHours',
    controls: ['deathSedentaryHours'],
    eyebrow: 'Activity 08',
    title: 'How many sedentary hours do you average per day?'
  },
  {
    id: 'smokingStatus',
    controls: ['deathSmokingStatus'],
    eyebrow: 'Substances 09',
    title: 'What is your smoking status?'
  },
  {
    id: 'yearsSinceQuit',
    controls: ['deathYearsSinceQuit'],
    eyebrow: 'Substances 10',
    title: 'How many years has it been since you quit?',
    isVisible: (controller) => controller.isFormerSmoker()
  },
  {
    id: 'drinksPerWeek',
    controls: ['deathDrinksPerWeek'],
    eyebrow: 'Substances 11',
    title: 'How many alcoholic drinks do you average per week?'
  },
  {
    id: 'bingeFrequency',
    controls: ['deathBingeFrequency'],
    eyebrow: 'Substances 12',
    title: 'How often do you binge drink?'
  },
  {
    id: 'sleepHours',
    controls: ['deathSleepHours'],
    eyebrow: 'Sleep And Diet 13',
    title: 'How many hours do you usually sleep per night?'
  },
  {
    id: 'upfShare',
    controls: ['deathUpfShare'],
    eyebrow: 'Sleep And Diet 14',
    title: 'How much of your diet is ultra-processed food?'
  },
  {
    id: 'produceServings',
    controls: ['deathProduceServings'],
    eyebrow: 'Sleep And Diet 15',
    title: 'How many fruit and vegetable servings do you average per day?'
  },
  {
    id: 'clinicalBloodPressure',
    controls: ['deathSystolicBloodPressure', 'deathDiastolicBloodPressure', 'deathUsesBloodPressureMedication'],
    eyebrow: 'Clinical Basics 16',
    title: 'Do you know your recent blood pressure?'
  },
  {
    id: 'clinicalCholesterol',
    controls: ['deathTotalCholesterol', 'deathHdlCholesterol', 'deathUsesLipidMedication'],
    eyebrow: 'Clinical Basics 17',
    title: 'Do you know your recent cholesterol numbers?'
  },
  {
    id: 'clinicalRestingHeartRate',
    controls: ['deathRestingHeartRate'],
    eyebrow: 'Clinical Basics 18',
    title: 'Do you know your resting heart rate?'
  },
  {
    id: 'hasHypertension',
    controls: ['deathHasHypertension'],
    eyebrow: 'Diagnosed Conditions 19',
    title: 'Have you been diagnosed with hypertension?'
  },
  {
    id: 'diabetesStatus',
    controls: ['deathDiabetesStatus'],
    eyebrow: 'Diagnosed Conditions 20',
    title: 'What is your diabetes status?'
  },
  {
    id: 'hasCardiovascularDisease',
    controls: ['deathHasCardioDisease'],
    eyebrow: 'Diagnosed Conditions 21',
    title: 'Do you have a history of heart disease or stroke?'
  },
  {
    id: 'hasCancerHistory',
    controls: ['deathHasCancerHistory'],
    eyebrow: 'Diagnosed Conditions 22',
    title: 'Do you have a cancer history?'
  },
  {
    id: 'hasCopdOrAsthma',
    controls: ['deathHasCopdOrAsthma'],
    eyebrow: 'Diagnosed Conditions 23',
    title: 'Do you have COPD or chronic asthma?'
  },
  {
    id: 'hasChronicKidneyDisease',
    controls: ['deathHasKidneyDisease'],
    eyebrow: 'Diagnosed Conditions 24',
    title: 'Do you have chronic kidney disease?'
  },
  {
    id: 'hasSleepApnea',
    controls: ['deathHasSleepApnea'],
    eyebrow: 'Diagnosed Conditions 25',
    title: 'Do you have sleep apnea?'
  },
  {
    id: 'hasEarlyFamilyCardioHistory',
    controls: ['deathEarlyFamilyCardio'],
    eyebrow: 'Family History 26',
    title: 'Did a parent or sibling have early heart disease or stroke?'
  },
  {
    id: 'parentLongevityBand',
    controls: ['deathParentLongevityBand'],
    eyebrow: 'Family History 27',
    title: 'How would you describe your parents’ longevity pattern?'
  }
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalNumber(value: FormDataEntryValue | null) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return null;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatYears(value: number) {
  if (value < 0.1) {
    return 'less than 0.1 years';
  }

  return `${value.toFixed(1)} ${value.toFixed(1) === '1.0' ? 'year' : 'years'}`;
}

export class DeathCalculatorController {
  private readonly root: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly introScreen: HTMLElement;
  private readonly surveyScreen: HTMLElement;
  private readonly resultScreen: HTMLElement;
  private readonly beginButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly calculateButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly statusText: HTMLElement;
  private readonly progressText: HTMLElement;
  private readonly progressMeta: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly questionEyebrow: HTMLElement;
  private readonly questionTitle: HTMLElement;
  private readonly questionDescription: HTMLElement;
  private readonly smokingStatus: HTMLSelectElement;
  private readonly yearsSinceQuitField: HTMLElement;
  private readonly yearsSinceQuitInput: HTMLInputElement;
  private readonly medianDate: HTMLElement;
  private readonly countdownDisplay: HTMLElement;
  private readonly resultMeta: HTMLElement;
  private readonly disclaimer: HTMLElement;
  private readonly moreInfoButton: HTMLButtonElement;
  private readonly moreInfoPanel: HTMLElement;
  private readonly centralRange: HTMLElement;
  private readonly wideRange: HTMLElement;
  private readonly survival5: HTMLElement;
  private readonly survival10: HTMLElement;
  private readonly survival20: HTMLElement;
  private readonly impactList: HTMLElement;
  private readonly detailsButton: HTMLButtonElement;
  private readonly detailsPanel: HTMLElement;
  private readonly modelSummary: HTMLElement;
  private readonly sourceList: HTMLElement;
  private readonly questionCards: Map<string, HTMLElement>;

  private activeQuestionId = QUESTION_DEFINITIONS[0]?.id ?? '';
  private activeScreen: DeathCalculatorScreen = 'intro';
  private countdownTimer = 0;
  private prediction: PredictionResult | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.form = this.requireElement('deathSurveyForm');
    this.introScreen = this.requireElement('deathIntroScreen');
    this.surveyScreen = this.requireElement('deathSurveyScreen');
    this.resultScreen = this.requireElement('deathResultScreen');
    this.beginButton = this.requireElement('deathBeginBtn');
    this.backButton = this.requireElement('deathBackBtn');
    this.nextButton = this.requireElement('deathNextBtn');
    this.calculateButton = this.requireElement('deathCalculateBtn');
    this.resetButton = this.requireElement('deathResetBtn');
    this.statusText = this.requireElement('deathStatusText');
    this.progressText = this.requireElement('deathProgressText');
    this.progressMeta = this.requireElement('deathProgressMeta');
    this.progressFill = this.requireElement('deathProgressFill');
    this.questionEyebrow = this.requireElement('deathQuestionEyebrow');
    this.questionTitle = this.requireElement('deathQuestionTitle');
    this.questionDescription = this.requireElement('deathQuestionDescription');
    this.smokingStatus = this.requireElement('deathSmokingStatus');
    this.yearsSinceQuitField = this.requireElement('deathYearsSinceQuitField');
    this.yearsSinceQuitInput = this.requireElement('deathYearsSinceQuit');
    this.medianDate = this.requireElement('deathMedianDate');
    this.countdownDisplay = this.requireElement('deathCountdownDisplay');
    this.resultMeta = this.requireElement('deathResultMeta');
    this.disclaimer = this.requireElement('deathDisclaimer');
    this.moreInfoButton = this.requireElement('deathMoreInfoBtn');
    this.moreInfoPanel = this.requireElement('deathMoreInfoPanel');
    this.centralRange = this.requireElement('deathCentralRange');
    this.wideRange = this.requireElement('deathWideRange');
    this.survival5 = this.requireElement('deathSurvival5');
    this.survival10 = this.requireElement('deathSurvival10');
    this.survival20 = this.requireElement('deathSurvival20');
    this.impactList = this.requireElement('deathImpactList');
    this.detailsButton = this.requireElement('deathDetailsBtn');
    this.detailsPanel = this.requireElement('deathDetailsPanel');
    this.modelSummary = this.requireElement('deathModelSummary');
    this.sourceList = this.requireElement('deathSourceList');
    this.questionCards = new Map(
      Array.from(this.root.querySelectorAll<HTMLElement>('[data-question-card]')).map((card) => [
        card.dataset.questionCard ?? '',
        card
      ])
    );
  }

  init() {
    this.beginButton.addEventListener('click', () => {
      this.begin();
    });

    this.backButton.addEventListener('click', () => {
      this.goToPreviousQuestion();
    });

    this.nextButton.addEventListener('click', () => {
      this.goToNextQuestion();
    });

    this.resetButton.addEventListener('click', () => {
      this.reset();
    });

    this.moreInfoButton.addEventListener('click', () => {
      this.toggleMoreInfo();
    });

    this.detailsButton.addEventListener('click', () => {
      this.toggleDetails();
    });

    this.smokingStatus.addEventListener('change', () => {
      this.syncFormerSmokerField();
      this.syncQuestionUi();
    });

    this.form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const visibleQuestions = this.getVisibleQuestions();
        const activeIndex = this.getActiveQuestionIndex(visibleQuestions);
        if (activeIndex < visibleQuestions.length - 1) {
          event.preventDefault();
          this.goToNextQuestion();
        }
      }
    });

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.calculatePrediction();
    });

    this.syncFormerSmokerField();
    this.reset();
  }

  private requireElement<T extends HTMLElement>(id: string) {
    const element = document.getElementById(id) as T | null;
    if (!element) {
      throw new Error(`Missing required Death Calculator element: ${id}`);
    }
    return element;
  }

  private getVisibleQuestions() {
    return QUESTION_DEFINITIONS.filter((question) => question.isVisible?.(this) ?? true);
  }

  private getActiveQuestionIndex(visibleQuestions: QuestionDefinition[]) {
    const activeIndex = visibleQuestions.findIndex((question) => question.id === this.activeQuestionId);
    return activeIndex >= 0 ? activeIndex : 0;
  }

  private setScreen(screen: DeathCalculatorScreen) {
    this.activeScreen = screen;
    this.root.dataset.state = screen;
    this.introScreen.hidden = screen !== 'intro';
    this.surveyScreen.hidden = screen !== 'question' && screen !== 'processing' && screen !== 'error';
    this.resultScreen.hidden = screen !== 'result';
  }

  private setStatus(text: string) {
    this.statusText.textContent = text;
  }

  private setProgress(activeIndex: number, totalQuestions: number) {
    const progress = totalQuestions <= 0 ? 0 : clamp((activeIndex + 1) / totalQuestions, 0, 1);
    this.progressText.textContent = `Question ${activeIndex + 1} of ${totalQuestions}`;
    this.progressMeta.textContent = `CDC ${longevityDataset.baselineYear} + SSA projection`;
    this.progressFill.style.width = `${Math.round(progress * 100)}%`;
    this.progressFill.parentElement?.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
  }

  private begin() {
    this.prediction = null;
    this.activeQuestionId = this.getVisibleQuestions()[0]?.id ?? QUESTION_DEFINITIONS[0]?.id ?? '';
    this.setStatus('Complete each section to run the actuarial model.');
    this.setScreen('question');
    this.syncQuestionUi();
    this.focusCalculator();
  }

  private syncFormerSmokerField() {
    const isFormerSmoker = this.isFormerSmoker();
    this.yearsSinceQuitField.hidden = !isFormerSmoker;
    this.yearsSinceQuitInput.required = isFormerSmoker;
    if (!isFormerSmoker) {
      this.yearsSinceQuitInput.value = '5';
    }
  }

  isFormerSmoker() {
    return this.smokingStatus.value === 'former';
  }

  private syncQuestionUi() {
    const visibleQuestions = this.getVisibleQuestions();
    const activeIndex = this.getActiveQuestionIndex(visibleQuestions);
    const activeQuestion = visibleQuestions[activeIndex];

    if (!activeQuestion) {
      return;
    }

    this.activeQuestionId = activeQuestion.id;
    this.questionCards.forEach((card, id) => {
      const shouldShow = id === activeQuestion.id;
      card.hidden = !shouldShow;
      card.classList.toggle('is-active', shouldShow);
    });

    this.questionEyebrow.textContent = activeQuestion.eyebrow;
    this.questionTitle.textContent = activeQuestion.title;
    this.questionDescription.textContent = '';
    this.questionDescription.hidden = true;
    this.setProgress(activeIndex, visibleQuestions.length);
    this.backButton.disabled = activeIndex === 0 || this.activeScreen === 'processing';
    this.nextButton.hidden = activeIndex === visibleQuestions.length - 1;
    this.nextButton.disabled = this.activeScreen === 'processing';
    this.calculateButton.hidden = activeIndex !== visibleQuestions.length - 1;
    this.calculateButton.disabled = this.activeScreen === 'processing';
  }

  private validateQuestion(question: QuestionDefinition) {
    for (const controlId of question.controls) {
      const control = this.requireElement<HTMLInputElement | HTMLSelectElement>(controlId);
      if (control.closest('[hidden]')) {
        continue;
      }
      if (!control.reportValidity()) {
        return false;
      }
    }

    return true;
  }

  private goToPreviousQuestion() {
    const visibleQuestions = this.getVisibleQuestions();
    const activeIndex = this.getActiveQuestionIndex(visibleQuestions);
    if (activeIndex <= 0) {
      return;
    }

    this.activeQuestionId = visibleQuestions[activeIndex - 1].id;
    this.setStatus('Previous section restored for review.');
    this.setScreen('question');
    this.syncQuestionUi();
    this.focusCalculator();
  }

  private goToNextQuestion() {
    const visibleQuestions = this.getVisibleQuestions();
    const activeIndex = this.getActiveQuestionIndex(visibleQuestions);
    const activeQuestion = visibleQuestions[activeIndex];
    if (!activeQuestion || !this.validateQuestion(activeQuestion)) {
      return;
    }

    const nextQuestion = visibleQuestions[activeIndex + 1];
    if (!nextQuestion) {
      return;
    }

    this.activeQuestionId = nextQuestion.id;
    this.setStatus('Section recorded.');
    this.setScreen('question');
    this.syncQuestionUi();
    this.focusCalculator();
  }

  private async calculatePrediction() {
    const visibleQuestions = this.getVisibleQuestions();
    const activeIndex = this.getActiveQuestionIndex(visibleQuestions);
    const activeQuestion = visibleQuestions[activeIndex];
    if (!activeQuestion || !this.validateQuestion(activeQuestion)) {
      return;
    }

    try {
      this.setScreen('processing');
      this.syncQuestionUi();
      this.setStatus('Running the actuarial model against the evidence snapshot.');
      const prediction = predictLongevity(this.collectAnswers(), longevityDataset);
      this.renderPrediction(prediction);
    } catch (error) {
      this.prediction = null;
      this.stopCountdown();
      this.setScreen('error');
      this.setStatus(error instanceof Error ? error.message : 'Unable to calculate prediction.');
      this.syncQuestionUi();
    }
  }

  private collectAnswers(): LongevitySurveyAnswers {
    const formData = new FormData(this.form);
    const heightFeet = parseNumber(String(formData.get('heightFeet') ?? '0'), 0);
    const heightInchesPart = parseNumber(String(formData.get('heightInchesPart') ?? '0'), 0);
    const smokingStatus = String(formData.get('smokingStatus') ?? 'never') as SmokingStatus;

    return {
      birthDate: String(formData.get('birthDate') ?? ''),
      sex: String(formData.get('sex') ?? 'male') as LongevitySurveyAnswers['sex'],
      heightInches: heightFeet * 12 + heightInchesPart,
      weightPounds: parseNumber(String(formData.get('weightPounds') ?? '0'), 0),
      moderateMinutesPerWeek: parseNumber(String(formData.get('moderateDaysPerWeek') ?? '0'), 0) * parseNumber(String(formData.get('moderateMinutesSession') ?? '0'), 0),
      vigorousMinutesPerWeek: parseNumber(String(formData.get('vigorousDaysPerWeek') ?? '0'), 0) * parseNumber(String(formData.get('vigorousMinutesSession') ?? '0'), 0),
      strengthDaysPerWeek: parseNumber(String(formData.get('strengthDaysPerWeek') ?? '0'), 0),
      sedentaryHoursPerDay: parseNumber(String(formData.get('sedentaryHoursPerDay') ?? '0'), 0),
      smokingStatus,
      yearsSinceQuit:
        smokingStatus === 'former' ? parseNumber(String(formData.get('yearsSinceQuit') ?? '0'), 0) : null,
      drinksPerWeek: parseNumber(String(formData.get('drinksPerWeek') ?? '0'), 0),
      bingeFrequency: String(formData.get('bingeFrequency') ?? 'never') as LongevitySurveyAnswers['bingeFrequency'],
      sleepHoursPerNight: parseNumber(String(formData.get('sleepHoursPerNight') ?? '0'), 0),
      ultraProcessedFoodShare: String(formData.get('ultraProcessedFoodShare') ?? 'moderate') as LongevitySurveyAnswers['ultraProcessedFoodShare'],
      fruitVegetableServingsPerDay: parseNumber(String(formData.get('fruitVegetableServingsPerDay') ?? '0'), 0),
      systolicBloodPressure: parseOptionalNumber(formData.get('systolicBloodPressure')),
      diastolicBloodPressure: parseOptionalNumber(formData.get('diastolicBloodPressure')),
      usesBloodPressureMedication: formData.get('usesBloodPressureMedication') === 'on',
      totalCholesterol: parseOptionalNumber(formData.get('totalCholesterol')),
      hdlCholesterol: parseOptionalNumber(formData.get('hdlCholesterol')),
      usesLipidMedication: formData.get('usesLipidMedication') === 'on',
      restingHeartRate: parseOptionalNumber(formData.get('restingHeartRate')),
      hasHypertension: formData.get('hasHypertension') === 'on',
      diabetesStatus: String(formData.get('diabetesStatus') ?? 'none') as LongevitySurveyAnswers['diabetesStatus'],
      hasCardiovascularDisease: formData.get('hasCardiovascularDisease') === 'on',
      hasCancerHistory: formData.get('hasCancerHistory') === 'on',
      hasCopdOrAsthma: formData.get('hasCopdOrAsthma') === 'on',
      hasChronicKidneyDisease: formData.get('hasChronicKidneyDisease') === 'on',
      hasSleepApnea: formData.get('hasSleepApnea') === 'on',
      hasEarlyFamilyCardioHistory: formData.get('hasEarlyFamilyCardioHistory') === 'on',
      parentLongevityBand: String(formData.get('parentLongevityBand') ?? 'mixed') as LongevitySurveyAnswers['parentLongevityBand']
    };
  }

  private renderPrediction(prediction: PredictionResult) {
    this.prediction = prediction;
    this.medianDate.textContent = formatPredictionDate(prediction.medianTimestamp);
    this.resultMeta.textContent =
      `Median projected date from the personalized survival curve. Future-year baseline hazards use ${prediction.projectionLabel}.`;
    this.disclaimer.textContent =
      `${prediction.modelDisclaimer} Evidence snapshot: ${prediction.dataVersion}. Projection: ${prediction.projectionId}.`;
    this.renderMoreInfo(prediction);
    this.setMoreInfoExpanded(false);
    this.setDetailsExpanded(false);
    this.setStatus('Actuarial estimate ready.');
    this.setScreen('result');
    this.startCountdown(prediction.medianTimestamp);
    this.focusCalculator();
  }

  private renderMoreInfo(prediction: PredictionResult) {
    this.centralRange.textContent =
      `${formatPredictionDate(prediction.projectedRange.central.lowerTimestamp)} to ${formatPredictionDate(prediction.projectedRange.central.upperTimestamp)}`;
    this.wideRange.textContent =
      `Wide model range: ${formatPredictionDate(prediction.projectedRange.wide.lowerTimestamp)} to ${formatPredictionDate(prediction.projectedRange.wide.upperTimestamp)}.`;

    this.survival5.textContent = formatPercent(prediction.survivalProbabilities.years5);
    this.survival10.textContent = formatPercent(prediction.survivalProbabilities.years10);
    this.survival20.textContent = formatPercent(prediction.survivalProbabilities.years20);

    this.impactList.replaceChildren();
    if (prediction.impactBreakdown.length === 0) {
      const item = document.createElement('li');
      item.textContent = 'No single answer moved the estimate by at least 0.1 years.';
      this.impactList.append(item);
    } else {
      prediction.impactBreakdown.forEach((impact) => {
        const item = document.createElement('li');
        item.textContent = `${impact.label}: moved estimate ${impact.direction} by ${formatYears(impact.years)}.`;
        this.impactList.append(item);
      });
    }

    this.modelSummary.textContent =
      `CDC ${prediction.modelDetails.baselineYear} full U.S. life tables, ${prediction.modelDetails.projectionLabel}, evidence snapshot ${prediction.modelDetails.dataVersion}, methodology v${prediction.modelDetails.methodologyVersion}. Ranges are model projections, not guarantees or medical advice.`;
    this.renderSources(prediction);
  }

  private renderSources(prediction: PredictionResult) {
    this.sourceList.replaceChildren();
    prediction.modelDetails.sources.forEach((source) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.title;
      const meta = document.createElement('span');
      meta.textContent =
        ` ${source.evidenceGrade}; published ${source.publishedDate ?? 'date unavailable'}; retrieved ${new Date(source.retrievedAt).toLocaleDateString('en-US')}.`;
      item.append(link, meta);
      this.sourceList.append(item);
    });
  }

  private toggleMoreInfo() {
    this.setMoreInfoExpanded(this.moreInfoPanel.hidden);
  }

  private toggleDetails() {
    this.setDetailsExpanded(this.detailsPanel.hidden);
  }

  private setMoreInfoExpanded(isExpanded: boolean) {
    this.moreInfoPanel.hidden = !isExpanded;
    this.moreInfoButton.setAttribute('aria-expanded', String(isExpanded));
    this.moreInfoButton.textContent = isExpanded ? 'Hide Info' : 'More Info';
    if (!isExpanded) {
      this.setDetailsExpanded(false);
    }
  }

  private setDetailsExpanded(isExpanded: boolean) {
    this.detailsPanel.hidden = !isExpanded;
    this.detailsButton.setAttribute('aria-expanded', String(isExpanded));
    this.detailsButton.textContent = isExpanded ? 'Hide Details' : 'Details';
  }

  private startCountdown(targetTimestamp: number) {
    this.stopCountdown();

    const render = () => {
      this.countdownDisplay.textContent = formatCountdownDisplay(targetTimestamp);
    };

    render();
    this.countdownTimer = window.setInterval(render, 1000);
  }

  private stopCountdown() {
    if (this.countdownTimer) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = 0;
    }
  }

  private reset() {
    this.form.reset();
    this.prediction = null;
    this.stopCountdown();
    this.activeQuestionId = this.getVisibleQuestions()[0]?.id ?? QUESTION_DEFINITIONS[0]?.id ?? '';
    this.medianDate.textContent = 'Projected date will appear here';
    this.countdownDisplay.textContent = '00:000:00:00:00';
    this.resultMeta.textContent = 'Complete the survey to reveal the median projected date.';
    this.disclaimer.textContent =
      'This actuarial estimate uses U.S. life tables, mortality-improvement projections, and curated public-health evidence. It is not a medical diagnosis.';
    this.centralRange.textContent = 'Complete the survey to reveal the central range.';
    this.wideRange.textContent = 'Wide range will appear here.';
    this.survival5.textContent = '--';
    this.survival10.textContent = '--';
    this.survival20.textContent = '--';
    this.impactList.replaceChildren();
    const placeholderImpact = document.createElement('li');
    placeholderImpact.textContent = 'Complete the survey to reveal the largest model inputs.';
    this.impactList.append(placeholderImpact);
    this.modelSummary.textContent = 'Model details will appear here.';
    this.sourceList.replaceChildren();
    this.setMoreInfoExpanded(false);
    this.setDetailsExpanded(false);
    this.syncFormerSmokerField();
    this.setStatus(
      'A local-only actuarial estimate built from U.S. life tables and public-health evidence. Your answers are never cached or saved.'
    );
    this.setScreen('intro');
    this.syncQuestionUi();
  }

  private focusCalculator() {
    window.requestAnimationFrame(() => {
      this.root.scrollIntoView({ behavior: 'auto', block: 'center' });
    });
  }
}
