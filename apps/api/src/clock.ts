// Domain code reads time only through a Clock, so tests can pin it with FixedClock.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class FixedClock implements Clock {
  #ms: number;

  constructor(start: Date | string) {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  advance(ms: number): void {
    this.#ms += ms;
  }
}
