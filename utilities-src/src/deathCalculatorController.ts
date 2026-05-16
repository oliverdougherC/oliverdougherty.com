import { longevityDataset } from './longevityDataset';
import {
  DAYS_PER_YEAR,
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
  description: string;
  isVisible?: (controller: DeathCalculatorController) => boolean;
}

const QUESTION_DEFINITIONS: QuestionDefinition[] = [
  {
    id: 'birthDate',
    controls: ['deathBirthDate'],
    eyebrow: 'Question 01',
    title: 'When were you born?',
    description: 'This anchors the actuarial baseline for the model.'
  },
  {
    id: 'sex',
    controls: ['deathSex'],
    eyebrow: 'Question 02',
    title: 'Which actuarial baseline should the model use?',
    description: 'The calculator uses male or female U.S. life tables.'
  },
  {
    id: 'weight',
    controls: ['deathWeightPounds'],
    eyebrow: 'Question 03',
    title: 'What is your weight?',
    description: 'Weight combines with height to calculate body-mass-index effects.'
  },
  {
    id: 'height',
    controls: ['deathHeightFeet', 'deathHeightInchesPart'],
    eyebrow: 'Question 04',
    title: 'How tall are you?',
    description: 'Feet and extra inches are collected together on one card.'
  },
  {
    id: 'moderateMinutes',
    controls: ['deathModerateDays', 'deathModerateMinutesSession'],
    eyebrow: 'Question 05',
    title: 'How much moderate activity do you get?',
    description: 'Examples: brisk walking, easy cycling, hiking.'
  },
  {
    id: 'vigorousMinutes',
    controls: ['deathVigorousDays', 'deathVigorousMinutesSession'],
    eyebrow: 'Question 06',
    title: 'How much vigorous activity do you get?',
    description: 'Examples: running, hard cycling, interval training.'
  },
  {
    id: 'strengthDays',
    controls: ['deathStrengthDays'],
    eyebrow: 'Question 07',
    title: 'How many days per week do you do strength training?',
    description: 'Lifting, resistance work, or other structured strength sessions.'
  },
  {
    id: 'sedentaryHours',
    controls: ['deathSedentaryHours'],
    eyebrow: 'Question 08',
    title: 'How many sedentary hours do you average per day?',
    description: 'Count desk time, couch time, and other long sitting blocks.'
  },
  {
    id: 'smokingStatus',
    controls: ['deathSmokingStatus'],
    eyebrow: 'Question 09',
    title: 'What is your smoking status?',
    description: 'Smoking is one of the strongest lifestyle signals in the model.'
  },
  {
    id: 'yearsSinceQuit',
    controls: ['deathYearsSinceQuit'],
    eyebrow: 'Question 10',
    title: 'How many years has it been since you quit?',
    description: 'This follow-up only appears for former smokers.',
    isVisible: (controller) => controller.isFormerSmoker()
  },
  {
    id: 'drinksPerWeek',
    controls: ['deathDrinksPerWeek'],
    eyebrow: 'Question 11',
    title: 'How many alcoholic drinks do you average per week?',
    description: 'Alcohol is modeled conservatively as a risk signal, not a protective one.'
  },
  {
    id: 'bingeFrequency',
    controls: ['deathBingeFrequency'],
    eyebrow: 'Question 12',
    title: 'How often do you binge drink?',
    description: 'This captures concentrated alcohol risk separately from weekly totals.'
  },
  {
    id: 'sleepHours',
    controls: ['deathSleepHours'],
    eyebrow: 'Question 13',
    title: 'How many hours do you usually sleep per night?',
    description: 'Very short and very long sleep patterns both affect the estimate.'
  },
  {
    id: 'upfShare',
    controls: ['deathUpfShare'],
    eyebrow: 'Question 14',
    title: 'How much of your diet is ultra-processed food?',
    description: 'Use the option that best matches your overall intake pattern.'
  },
  {
    id: 'produceServings',
    controls: ['deathProduceServings'],
    eyebrow: 'Question 15',
    title: 'How many fruit and vegetable servings do you average per day?',
    description: 'This is modeled as a broad diet-quality signal.'
  },
  {
    id: 'hasHypertension',
    controls: ['deathHasHypertension'],
    eyebrow: 'Question 16',
    title: 'Have you been diagnosed with hypertension?',
    description: 'Diagnosed conditions are weighted more heavily than softer lifestyle inputs.'
  },
  {
    id: 'clinicalBiomarkers',
    controls: [
      'deathSystolicBloodPressure',
      'deathDiastolicBloodPressure',
      'deathUsesBloodPressureMedication',
      'deathTotalCholesterol',
      'deathHdlCholesterol',
      'deathUsesLipidMedication',
      'deathRestingHeartRate'
    ],
    eyebrow: 'Question 17',
    title: 'Do you know any recent clinical numbers?',
    description: 'Optional biomarkers refine the estimate when you have them.'
  },
  {
    id: 'diabetesStatus',
    controls: ['deathDiabetesStatus'],
    eyebrow: 'Question 18',
    title: 'What is your diabetes status?',
    description: 'Prediabetes and diabetes are modeled separately.'
  },
  {
    id: 'hasCardiovascularDisease',
    controls: ['deathHasCardioDisease'],
    eyebrow: 'Question 19',
    title: 'Do you have a history of heart disease or stroke?',
    description: 'Major cardiovascular disease strongly influences the estimate.'
  },
  {
    id: 'hasCancerHistory',
    controls: ['deathHasCancerHistory'],
    eyebrow: 'Question 20',
    title: 'Do you have a cancer history?',
    description: 'This asks about diagnosed cancer history, not family history.'
  },
  {
    id: 'hasCopdOrAsthma',
    controls: ['deathHasCopdOrAsthma'],
    eyebrow: 'Question 21',
    title: 'Do you have COPD or chronic asthma?',
    description: 'Respiratory conditions are modeled as a separate risk cluster.'
  },
  {
    id: 'hasChronicKidneyDisease',
    controls: ['deathHasKidneyDisease'],
    eyebrow: 'Question 22',
    title: 'Do you have chronic kidney disease?',
    description: 'Kidney disease is treated as a major diagnosed condition.'
  },
  {
    id: 'hasSleepApnea',
    controls: ['deathHasSleepApnea'],
    eyebrow: 'Question 23',
    title: 'Do you have sleep apnea?',
    description: 'Sleep apnea is modeled independently from sleep duration.'
  },
  {
    id: 'hasEarlyFamilyCardioHistory',
    controls: ['deathEarlyFamilyCardio'],
    eyebrow: 'Question 24',
    title: 'Did a parent or sibling have early heart disease or stroke?',
    description: 'Family history is modeled lightly and never allowed to dominate the estimate.'
  },
  {
    id: 'parentLongevityBand',
    controls: ['deathParentLongevityBand'],
    eyebrow: 'Question 25',
    title: 'How would you describe your parents’ longevity pattern?',
    description: 'Use the option that most closely matches the available history.'
  }
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNullableNumber(value: FormDataEntryValue | null) {
  if (value === null) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
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
  private readonly statusText: HTMLElement | null;
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
  private questionCards: Map<string, HTMLElement>;

  private activeQuestionId = QUESTION_DEFINITIONS[0]?.id ?? '';
  private activeScreen: DeathCalculatorScreen = 'intro';
  private countdownTimer = 0;
  private formerSmokerSavedValue = '5';
  private readonly keydownHandler = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.repeat) {
      return;
    }
    if (this.activeScreen !== 'question' || this.surveyScreen.hidden) {
      return;
    }

    const target = event.target as HTMLElement;
    if (
      target !== document.body &&
      target !== document.documentElement &&
      !this.root.contains(target)
    ) {
      return;
    }
    if (target.closest?.('#deathBackBtn')) {
      return;
    }
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      return;
    }

    event.preventDefault();
    const visibleQuestions = this.getVisibleQuestions();
    const activeIndex = this.getActiveQuestionIndex(visibleQuestions);
    if (activeIndex < visibleQuestions.length - 1) {
      this.goToNextQuestion();
    } else {
      void this.calculatePrediction();
    }
  };
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
    this.statusText = document.getElementById('deathStatusText');
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
    this.questionCards = new Map(
      Array.from(this.root.querySelectorAll<HTMLElement>('[data-question-card]')).map((card) => [
        card.dataset.questionCard ?? '',
        card
      ])
    );
  }

  init() {
    this.questionCards = new Map(
      Array.from(this.root.querySelectorAll<HTMLElement>('[data-question-card]')).map((card) => [
        card.dataset.questionCard ?? '',
        card
      ])
    );
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

    this.smokingStatus.addEventListener('change', () => {
      this.syncFormerSmokerField();
      this.syncQuestionUi();
    });

    document.addEventListener('keydown', this.keydownHandler);

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const visibleQuestions = this.getVisibleQuestions();
      const activeIndex = this.getActiveQuestionIndex(visibleQuestions);
      if (activeIndex < visibleQuestions.length - 1) {
        this.goToNextQuestion();
        return;
      }
      void this.calculatePrediction();
    });

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
    this.introScreen.hidden = screen !== 'intro' && screen !== 'error';
    this.surveyScreen.hidden = screen !== 'question' && screen !== 'processing';
    this.resultScreen.hidden = screen !== 'result';
  }

  private setStatus(text: string) {
    this.root.dataset.deathStatusMessage = text;
    if (this.statusText) {
      this.statusText.textContent = text;
    }
  }

  private setProgress(activeIndex: number, totalQuestions: number) {
    const progress = totalQuestions <= 0 ? 0 : clamp((activeIndex + 1) / totalQuestions, 0, 1);
    this.progressText.textContent = `Question ${activeIndex + 1} of ${totalQuestions}`;
    this.progressMeta.textContent = `U.S.-only • evidence snapshot ${longevityDataset.dataVersion}`;
    this.progressFill.style.width = `${Math.round(progress * 100)}%`;
  }

  private begin() {
    this.activeQuestionId = this.getVisibleQuestions()[0]?.id ?? QUESTION_DEFINITIONS[0]?.id ?? '';
    this.setStatus('Answer each card and move straight through the flow.');
    this.setScreen('question');
    this.syncQuestionUi();
    this.focusActiveControl();
  }

  private syncFormerSmokerField() {
    const isFormerSmoker = this.isFormerSmoker();
    this.yearsSinceQuitField.hidden = !isFormerSmoker;
    this.yearsSinceQuitInput.required = isFormerSmoker;
    if (isFormerSmoker) {
      this.yearsSinceQuitInput.value = this.formerSmokerSavedValue;
    } else {
      this.formerSmokerSavedValue = this.yearsSinceQuitInput.value || '5';
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
    this.questionDescription.textContent = activeQuestion.description;
    this.setProgress(activeIndex, visibleQuestions.length);
    this.backButton.disabled = activeIndex === 0 || this.activeScreen === 'processing';
    this.nextButton.hidden = activeIndex === visibleQuestions.length - 1;
    this.nextButton.disabled = this.activeScreen === 'processing';
    this.calculateButton.hidden = activeIndex !== visibleQuestions.length - 1;
    this.calculateButton.disabled = this.activeScreen === 'processing';
  }

  private focusActiveControl() {
    const card = this.questionCards.get(this.activeQuestionId);
    if (!card) return;
    const control = card.querySelector<HTMLElement>('input:not([hidden]):not([disabled]), select:not([hidden]):not([disabled])');
    control?.focus();
  }

  /**
   * Browsers may leave `value` empty until the field is focused even when the HTML `value` attribute
   * sets a default. Syncing from `defaultValue` makes Enter-to-advance match the visible defaults.
   */
  private syncDefaultIfNeeded(control: HTMLInputElement | HTMLSelectElement) {
    if (control instanceof HTMLInputElement) {
      if (
        control.type === 'checkbox' ||
        control.type === 'file' ||
        control.type === 'hidden' ||
        control.disabled
      ) {
        return;
      }
      if (control.required && control.value === '' && control.defaultValue !== '') {
        control.value = control.defaultValue;
      }
    }
  }

  private validateQuestion(question: QuestionDefinition) {
    for (const controlId of question.controls) {
      const control = this.requireElement<HTMLInputElement | HTMLSelectElement>(controlId);
      if (control.closest('[hidden]')) {
        continue;
      }
      this.syncDefaultIfNeeded(control);
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
    this.setStatus('Move backward if you need to change an answer.');
    this.setScreen('question');
    this.syncQuestionUi();
    this.focusActiveControl();
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
    this.setStatus('Locked in. Keep going.');
    this.setScreen('question');
    this.syncQuestionUi();
    this.focusActiveControl();
  }

  private async calculatePrediction() {
    const visibleQuestions = this.getVisibleQuestions();
    const activeIndex = this.getActiveQuestionIndex(visibleQuestions);
    const activeQuestion = visibleQuestions[activeIndex];
    if (!activeQuestion || !this.validateQuestion(activeQuestion)) {
      return;
    }

    const birthDateControl = this.requireElement<HTMLInputElement>('deathBirthDate');
    if (!birthDateControl.value.trim()) {
      this.activeQuestionId = 'birthDate';
      this.setScreen('question');
      this.syncQuestionUi();
      birthDateControl.reportValidity();
      return;
    }

    const answers = this.collectAnswers();
    const birthDate = new Date(`${answers.birthDate}T12:00:00Z`);
    const ageYears = (Date.now() - birthDate.getTime()) / (DAYS_PER_YEAR * 24 * 60 * 60 * 1000);

    if (ageYears > 122) {
      this.renderImmortal();
      return;
    }
    if (ageYears < 18) {
      this.setScreen('error');
      this.setStatus('This calculator is only available to adults 18 and older.');
      this.beginButton.textContent = 'Review answers';
      return;
    }

    try {
      this.setScreen('processing');
      this.syncQuestionUi();
      this.setStatus('Running the longevity model against the evidence snapshot…');
      const prediction = predictLongevity(answers, longevityDataset);
      this.renderPrediction(prediction);
    } catch (error) {
      this.stopCountdown();
      this.setScreen('error');
      this.setStatus(error instanceof Error ? error.message : 'Unable to calculate prediction.');
      this.beginButton.textContent = 'Review answers';
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
      systolicBloodPressure: parseNullableNumber(formData.get('systolicBloodPressure')),
      diastolicBloodPressure: parseNullableNumber(formData.get('diastolicBloodPressure')),
      usesBloodPressureMedication: formData.get('usesBloodPressureMedication') === 'on',
      totalCholesterol: parseNullableNumber(formData.get('totalCholesterol')),
      hdlCholesterol: parseNullableNumber(formData.get('hdlCholesterol')),
      usesLipidMedication: formData.get('usesLipidMedication') === 'on',
      restingHeartRate: parseNullableNumber(formData.get('restingHeartRate')),
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

  private renderImmortal() {
    this.stopCountdown();
    this.medianDate.textContent = 'You appear to be immortal.';
    this.countdownDisplay.textContent = '';
    const infinity = document.createElement('span');
    infinity.className = 'death-infinity';
    infinity.setAttribute('aria-label', 'Infinity');
    infinity.textContent = '∞';
    this.countdownDisplay.appendChild(infinity);
    this.resultMeta.textContent = 'Enjoy time\u2026';

    const legend = this.root.querySelector('.death-countdown-legend');
    if (legend) (legend as HTMLElement).hidden = true;
    const label = this.root.querySelector('.death-result-label');
    if (label) (label as HTMLElement).hidden = true;

    this.disclaimer.textContent = '';
    this.setStatus('Immortality detected.');
    this.setScreen('result');
  }

  private renderPrediction(prediction: PredictionResult) {
    this.medianDate.textContent = formatPredictionDate(prediction.medianTimestamp);
    this.resultMeta.textContent =
      'The model uses the 50th percentile of the personalized survival curve as the estimate shown here.';
    this.disclaimer.textContent =
      `${prediction.modelDisclaimer} Data version: ${prediction.dataVersion}.`;
    this.setStatus('Estimate ready.');
    this.setScreen('result');
    this.startCountdown(prediction.medianTimestamp);
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
    this.stopCountdown();
    this.activeQuestionId = this.getVisibleQuestions()[0]?.id ?? QUESTION_DEFINITIONS[0]?.id ?? '';
    this.medianDate.textContent = 'Estimated date will appear here';
    this.countdownDisplay.textContent = '00:000:00:00:00';
    this.resultMeta.textContent = 'Answer every card to reveal the estimate.';
    this.disclaimer.textContent =
      'This is a modeled estimate based on U.S. actuarial life tables and curated public-health evidence. It is not a medical diagnosis.';

    const legend = this.root.querySelector('.death-countdown-legend');
    if (legend) (legend as HTMLElement).hidden = false;
    const labels = this.root.querySelectorAll('.death-result-label');
    labels.forEach((el) => ((el as HTMLElement).hidden = false));

    this.formerSmokerSavedValue = '5';
    this.beginButton.textContent = 'Begin?';
    this.syncFormerSmokerField();
    this.setStatus('A local-only estimate built from U.S. life tables and public-health evidence.');
    this.setScreen('intro');
  }

  public dispose() {
    document.removeEventListener('keydown', this.keydownHandler);
    this.stopCountdown();
  }
}
