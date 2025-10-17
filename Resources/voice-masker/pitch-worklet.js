class PitchMaskProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'pitch',
        defaultValue: 0.7,
        minValue: 0.25,
        maxValue: 2.5,
        automationRate: 'a-rate'
      }
    ];
  }

  constructor() {
    super();
    this.sampleRate = sampleRate;
    this.bufferSize = this.sampleRate * 4;
    this.buffer = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.readPos = 0;
    this.minDelay = Math.floor(this.sampleRate * 0.05);
    this.maxDelay = Math.floor(this.sampleRate * 0.45);
    this.initialized = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'reset') {
        this.writePos = 0;
        this.readPos = 0;
        this.initialized = false;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) {
      return true;
    }

    const inChannel = input[0];
    const outChannel = output[0];
    const pitchValues = parameters.pitch;
    const isConstant = pitchValues.length === 1;

    for (let i = 0; i < inChannel.length; i++) {
      this.buffer[this.writePos % this.bufferSize] = inChannel[i];
      this.writePos++;
    }

    if (!this.initialized) {
      const delay = Math.min(Math.max(this.minDelay * 2, 0), this.maxDelay);
      this.readPos = this.writePos - delay;
      this.initialized = true;
    }

    const safetyLower = this.writePos - this.maxDelay;
    if (this.readPos < safetyLower) {
      this.readPos = safetyLower;
    }

    const safetyUpper = this.writePos - this.minDelay;
    if (this.readPos > safetyUpper) {
      this.readPos = safetyUpper;
    }

    for (let i = 0; i < outChannel.length; i++) {
      let ratio = isConstant ? pitchValues[0] : pitchValues[i];
      if (!Number.isFinite(ratio)) {
        ratio = 0.7;
      }
      ratio = Math.min(Math.max(ratio, 0.25), 2.5);

      this.readPos += ratio;
      if (this.readPos > this.writePos - this.minDelay) {
        this.readPos = this.writePos - this.minDelay;
      }
      if (this.readPos < this.writePos - this.maxDelay) {
        this.readPos = this.writePos - this.maxDelay;
      }

      const baseIndex = Math.floor(this.readPos);
      const nextIndex = baseIndex + 1;
      const frac = this.readPos - baseIndex;
      const idx0 = ((baseIndex % this.bufferSize) + this.bufferSize) % this.bufferSize;
      const idx1 = ((nextIndex % this.bufferSize) + this.bufferSize) % this.bufferSize;
      const sample0 = this.buffer[idx0] || 0;
      const sample1 = this.buffer[idx1] || 0;
      outChannel[i] = sample0 + (sample1 - sample0) * frac;
    }

    return true;
  }
}

registerProcessor('pitch-mask-processor', PitchMaskProcessor);
