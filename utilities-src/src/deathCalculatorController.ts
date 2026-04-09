import { longevityDataset } from './longevityDataset';
import {
  formatCountdown,
  formatPredictionDate,
  formatProbability,
  predictLongevity
} from './longevityEngine';
import type { LongevitySurveyAnswers, PredictionResult, SmokingStatus } from './longevityTypes';

const STEP_TITLES = ['Basics', 'Lifestyle', 'Medical history', 'Family history'];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatHazardShift(logHazard: number) {
  const shift = (Math.exp(Math.abs(logHazard)) - 1) * 100;
  return `${logHazard >= 0 ? '+' : '-'}${shift.toFixed(0)}% hazard`;
}

export class DeathCalculatorController {
  private readonly root: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly stepPanels: HTMLElement[];
  private readonly statusChip: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly progressText: HTMLElement;
  private readonly progressMeta: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly stepMeta: HTMLElement;
  private readonly stepProgressFill: HTMLElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly calculateButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly smokingStatus: HTMLSelectElement;
  private readonly yearsSinceQuitField: HTMLElement;
  private readonly yearsSinceQuitInput: HTMLInputElement;
  private readonly medianDate: HTMLElement;
  private readonly rangeText: HTMLElement;
  private readonly resultMeta: HTMLElement;
  private readonly survival5: HTMLElement;
  private readonly survival10: HTMLElement;
  private readonly survival20: HTMLElement;
  private readonly hazardMultiplier: HTMLElement;
  private readonly baselineYears: HTMLElement;
  private readonly countdownYears: HTMLElement;
  private readonly countdownDays: HTMLElement;
  private readonly countdownHours: HTMLElement;
  private readonly countdownMinutes: HTMLElement;
  private readonly countdownSeconds: HTMLElement;
  private readonly positiveDrivers: HTMLElement;
  private readonly negativeDrivers: HTMLElement;
  private readonly disclaimer: HTMLElement;
  private readonly sourceList: HTMLElement;

  private currentStep = 0;
  private countdownTimer = 0;
  private prediction: PredictionResult | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.form = this.requireElement('deathSurveyForm');
    this.stepPanels = Array.from(this.root.querySelectorAll<HTMLElement>('[data-step-panel]'));
    this.statusChip = this.requireElement('deathStatusChip');
    this.statusText = this.requireElement('deathStatusText');
    this.progressText = this.requireElement('deathProgressText');
    this.progressMeta = this.requireElement('deathProgressMeta');
    this.progressBar = this.requireElement('deathProgressBar');
    this.progressFill = this.requireElement('deathProgressFill');
    this.stepMeta = this.requireElement('deathStepMeta');
    this.stepProgressFill = this.requireElement('deathStepProgressFill');
    this.nextButton = this.requireElement('deathNextBtn');
    this.backButton = this.requireElement('deathBackBtn');
    this.calculateButton = this.requireElement('deathCalculateBtn');
    this.resetButton = this.requireElement('deathResetBtn');
    this.smokingStatus = this.requireElement('deathSmokingStatus');
    this.yearsSinceQuitField = this.requireElement('deathYearsSinceQuitField');
    this.yearsSinceQuitInput = this.requireElement('deathYearsSinceQuit');
    this.medianDate = this.requireElement('deathMedianDate');
    this.rangeText = this.requireElement('deathRangeText');
    this.resultMeta = this.requireElement('deathResultMeta');
    this.survival5 = this.requireElement('deathSurvival5');
    this.survival10 = this.requireElement('deathSurvival10');
    this.survival20 = this.requireElement('deathSurvival20');
    this.hazardMultiplier = this.requireElement('deathHazardMultiplier');
    this.baselineYears = this.requireElement('deathBaselineYears');
    this.countdownYears = this.requireElement('deathCountdownYears');
    this.countdownDays = this.requireElement('deathCountdownDays');
    this.countdownHours = this.requireElement('deathCountdownHours');
    this.countdownMinutes = this.requireElement('deathCountdownMinutes');
    this.countdownSeconds = this.requireElement('deathCountdownSeconds');
    this.positiveDrivers = this.requireElement('deathPositiveDrivers');
    this.negativeDrivers = this.requireElement('deathNegativeDrivers');
    this.disclaimer = this.requireElement('deathDisclaimer');
    this.sourceList = this.requireElement('deathSourceList');
  }

  init() {
    this.nextButton.addEventListener('click', () => {
      if (!this.validateActiveStep()) {
        return;
      }
      this.currentStep = clamp(this.currentStep + 1, 0, this.stepPanels.length - 1);
      this.syncStepUi();
    });

    this.backButton.addEventListener('click', () => {
      this.currentStep = clamp(this.currentStep - 1, 0, this.stepPanels.length - 1);
      this.syncStepUi();
    });

    this.resetButton.addEventListener('click', () => {
      this.reset();
    });

    this.smokingStatus.addEventListener('change', () => {
      this.syncFormerSmokerField();
    });

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!this.validateActiveStep()) {
        return;
      }

      try {
        this.setStatus('processing', 'Running the longevity model against the curated evidence snapshot…');
        this.setProgress(1, 'Calculating personalized survival curve…');
        const answers = this.collectAnswers();
        const prediction = predictLongevity(answers, longevityDataset);
        this.renderPrediction(prediction);
      } catch (error) {
        this.stopCountdown();
        this.prediction = null;
        this.setStatus('error', error instanceof Error ? error.message : 'Unable to calculate prediction.');
        this.setProgress(this.progressBarValue(), 'Review the answers and try again.');
        this.resultMeta.textContent = 'No prediction generated.';
      }
    });

    this.renderSourceList();
    this.syncFormerSmokerField();
    this.syncStepUi();
  }

  private requireElement<T extends HTMLElement>(id: string) {
    const element = document.getElementById(id) as T | null;
    if (!element) {
      throw new Error(`Missing required Death Calculator element: ${id}`);
    }
    return element;
  }

  private progressBarValue() {
    return (this.currentStep + 1) / this.stepPanels.length;
  }

  private syncStepUi() {
    this.stepPanels.forEach((panel, index) => {
      const isActive = index === this.currentStep;
      panel.hidden = !isActive;
      panel.classList.toggle('is-active', isActive);
    });

    const progress = this.progressBarValue();
    this.stepMeta.textContent = `Step ${this.currentStep + 1} of ${this.stepPanels.length} · ${STEP_TITLES[this.currentStep]}`;
    this.stepProgressFill.style.width = `${Math.round(progress * 100)}%`;
    this.progressBar.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    this.progressFill.style.width = `${Math.round(progress * 100)}%`;
    this.backButton.disabled = this.currentStep === 0;
    this.nextButton.hidden = this.currentStep === this.stepPanels.length - 1;
    this.calculateButton.hidden = this.currentStep !== this.stepPanels.length - 1;

    if (!this.prediction) {
      this.setProgress(progress, `Survey step ${this.currentStep + 1} of ${this.stepPanels.length}.`);
      this.progressMeta.textContent = `U.S.-only · evidence snapshot ${longevityDataset.dataVersion}`;
    }
  }

  private syncFormerSmokerField() {
    const isFormerSmoker = this.smokingStatus.value === 'former';
    this.yearsSinceQuitField.hidden = !isFormerSmoker;
    this.yearsSinceQuitInput.required = isFormerSmoker;
    if (!isFormerSmoker) {
      this.yearsSinceQuitInput.value = '5';
    }
  }

  private validateActiveStep() {
    const activePanel = this.stepPanels[this.currentStep];
    const controls = Array.from(activePanel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'));

    for (const control of controls) {
      if (control.closest('[hidden]')) {
        continue;
      }
      if (!control.reportValidity()) {
        return false;
      }
    }

    return true;
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
      moderateMinutesPerWeek: parseNumber(String(formData.get('moderateMinutesPerWeek') ?? '0'), 0),
      vigorousMinutesPerWeek: parseNumber(String(formData.get('vigorousMinutesPerWeek') ?? '0'), 0),
      strengthDaysPerWeek: parseNumber(String(formData.get('strengthDaysPerWeek') ?? '0'), 0),
      sedentaryHoursPerDay: parseNumber(String(formData.get('sedentaryHoursPerDay') ?? '0'), 0),
      smokingStatus,
      yearsSinceQuit: smokingStatus === 'former' ? parseNumber(String(formData.get('yearsSinceQuit') ?? '0'), 0) : null,
      drinksPerWeek: parseNumber(String(formData.get('drinksPerWeek') ?? '0'), 0),
      bingeFrequency: String(formData.get('bingeFrequency') ?? 'never') as LongevitySurveyAnswers['bingeFrequency'],
      sleepHoursPerNight: parseNumber(String(formData.get('sleepHoursPerNight') ?? '0'), 0),
      ultraProcessedFoodShare: String(formData.get('ultraProcessedFoodShare') ?? 'moderate') as LongevitySurveyAnswers['ultraProcessedFoodShare'],
      fruitVegetableServingsPerDay: parseNumber(String(formData.get('fruitVegetableServingsPerDay') ?? '0'), 0),
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

  private setStatus(state: 'idle' | 'processing' | 'ready' | 'complete' | 'error', text: string) {
    this.statusChip.textContent =
      state === 'complete' ? 'Complete' : state === 'ready' ? 'Ready' : state[0].toUpperCase() + state.slice(1);
    this.statusChip.className = `utility-status-chip utility-status-chip--${state}`;
    this.statusText.textContent = text;
  }

  private setProgress(progress: number, text: string) {
    const bounded = clamp(progress, 0, 1);
    this.progressText.textContent = text;
    this.progressFill.style.width = `${Math.round(bounded * 100)}%`;
    this.progressBar.setAttribute('aria-valuenow', String(Math.round(bounded * 100)));
  }

  private renderPrediction(prediction: PredictionResult) {
    this.prediction = prediction;
    this.resultMeta.textContent = 'Median date is the 50th percentile of the personalized survival curve, not a claim of certainty.';
    this.medianDate.textContent = formatPredictionDate(prediction.medianTimestamp);
    this.rangeText.textContent = [
      `P10 ${formatPredictionDate(prediction.percentileTimestamps.p10)}`,
      `P25 ${formatPredictionDate(prediction.percentileTimestamps.p25)}`,
      `P50 ${formatPredictionDate(prediction.percentileTimestamps.p50)}`,
      `P75 ${formatPredictionDate(prediction.percentileTimestamps.p75)}`,
      `P90 ${formatPredictionDate(prediction.percentileTimestamps.p90)}`
    ].join(' • ');
    this.survival5.textContent = formatProbability(prediction.survivalProbabilities.years5);
    this.survival10.textContent = formatProbability(prediction.survivalProbabilities.years10);
    this.survival20.textContent = formatProbability(prediction.survivalProbabilities.years20);
    this.hazardMultiplier.textContent = `${prediction.totalHazardMultiplier.toFixed(2)}×`;
    this.baselineYears.textContent = `${prediction.baselineRemainingLifeExpectancy.toFixed(1)} yrs @ ${longevityDataset.baselineYear} table`;
    this.disclaimer.textContent = `${prediction.modelDisclaimer} Data version: ${prediction.dataVersion}.`;

    const negative = prediction.driverBreakdown.filter((driver) => driver.adjustedLogHazard > 0).slice(0, 4);
    const positive = prediction.driverBreakdown.filter((driver) => driver.adjustedLogHazard < 0).slice(0, 4);

    this.renderDriverList(
      this.negativeDrivers,
      negative.length > 0
        ? negative.map((driver) => `${driver.label} (${formatHazardShift(driver.adjustedLogHazard)})`)
        : ['No major shortening drivers surfaced beyond the actuarial baseline.']
    );
    this.renderDriverList(
      this.positiveDrivers,
      positive.length > 0
        ? positive.map((driver) => `${driver.label} (${formatHazardShift(driver.adjustedLogHazard)})`)
        : ['No protective drivers were strong enough to meaningfully beat the baseline.']
    );

    this.setStatus('complete', 'Longevity estimate ready. Review the range, countdown, and driver list together.');
    this.setProgress(1, 'Prediction complete.');
    this.progressMeta.textContent = `Median remaining life ${prediction.estimatedYearsRemaining.toFixed(1)} years • baseline year ${prediction.baselineYear}`;
    this.startCountdown(prediction.medianTimestamp);
  }

  private renderDriverList(target: HTMLElement, items: string[]) {
    target.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      target.appendChild(li);
    });
  }

  private renderSourceList() {
    this.sourceList.innerHTML = '';

    longevityDataset.sources.forEach((source) => {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.title;

      const meta = document.createElement('span');
      meta.textContent = ` · ${source.evidenceGrade} · published ${source.publishedDate ?? 'n/a'}`;

      const notes = document.createElement('p');
      notes.textContent = source.notes;

      li.append(link, meta, notes);
      this.sourceList.appendChild(li);
    });
  }

  private startCountdown(targetTimestamp: number) {
    this.stopCountdown();

    const render = () => {
      const countdown = formatCountdown(targetTimestamp);
      this.countdownYears.textContent = String(countdown.years);
      this.countdownDays.textContent = String(countdown.days);
      this.countdownHours.textContent = String(countdown.hours).padStart(2, '0');
      this.countdownMinutes.textContent = String(countdown.minutes).padStart(2, '0');
      this.countdownSeconds.textContent = String(countdown.seconds).padStart(2, '0');
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
    this.currentStep = 0;
    this.prediction = null;
    this.stopCountdown();
    this.syncFormerSmokerField();
    this.syncStepUi();
    this.setStatus('idle', 'Complete the four-part survey to generate a modeled longevity estimate.');
    this.setProgress(this.progressBarValue(), 'Waiting for survey input.');
    this.progressMeta.textContent = `U.S.-only · evidence snapshot ${longevityDataset.dataVersion}`;
    this.medianDate.textContent = 'Complete the survey to estimate.';
    this.rangeText.textContent = 'P10 to P90 range and survival probabilities will appear here.';
    this.resultMeta.textContent = 'The median date and range will appear here after the survey is complete.';
    this.survival5.textContent = '—';
    this.survival10.textContent = '—';
    this.survival20.textContent = '—';
    this.hazardMultiplier.textContent = '—';
    this.baselineYears.textContent = '—';
    this.countdownYears.textContent = '—';
    this.countdownDays.textContent = '—';
    this.countdownHours.textContent = '—';
    this.countdownMinutes.textContent = '—';
    this.countdownSeconds.textContent = '—';
    this.disclaimer.textContent =
      'This is a modeled estimate based on U.S. actuarial life tables and curated public-health evidence. It is not a medical diagnosis.';
    this.renderDriverList(this.negativeDrivers, ['Nothing calculated yet.']);
    this.renderDriverList(this.positiveDrivers, ['Nothing calculated yet.']);
  }
}
