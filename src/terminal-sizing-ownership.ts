export type TerminalViewportType = 'mobile' | 'tablet' | 'desktop';

export interface TerminalViewerDimensions {
  readonly cols: number;
  readonly rows: number;
  readonly viewportType: TerminalViewportType;
}

export interface TerminalSizingActivation {
  generation: number;
  changedOwner: boolean;
  dimensions: TerminalViewerDimensions | null;
}

export class TerminalSizingOwnership {
  private owner: symbol | null = null;
  private generation = 0;
  private readonly dimensions = new Map<symbol, TerminalViewerDimensions>();

  get ownerToken(): symbol | null {
    return this.owner;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  remember(token: symbol, dimensions: TerminalViewerDimensions): void {
    this.dimensions.set(token, { ...dimensions });
  }

  dimensionsFor(token: symbol): TerminalViewerDimensions | null {
    const dimensions = this.dimensions.get(token);
    return dimensions ? { ...dimensions } : null;
  }

  activate(token: symbol, dimensions?: TerminalViewerDimensions): TerminalSizingActivation {
    if (dimensions) {
      this.remember(token, dimensions);
    }
    const changedOwner = this.owner !== token;
    if (changedOwner) {
      this.owner = token;
      this.generation += 1;
    }
    return {
      generation: this.generation,
      changedOwner,
      dimensions: this.dimensionsFor(token),
    };
  }

  isOwner(token: symbol): boolean {
    return this.owner === token;
  }

  bootstrap(token: symbol): TerminalSizingActivation | null {
    if (this.owner !== null || !this.dimensions.has(token)) {
      return null;
    }
    return this.activate(token);
  }

  release(token: symbol): void {
    this.dimensions.delete(token);
    if (this.owner === token) {
      this.owner = null;
      this.generation += 1;
    }
  }

  clear(): void {
    this.dimensions.clear();
    if (this.owner !== null) {
      this.owner = null;
      this.generation += 1;
    }
  }
}
