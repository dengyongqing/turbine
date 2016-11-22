import {fgo} from "jabz/monad";
import {Now} from "hareactive/Now";
import {Behavior, placeholder, observe, at, sink} from "hareactive/Behavior";

// Quick n' dirty proof of concept implementation

function id<A>(a: A): A { return a; };
function snd<A, B>(a: [A, B]): B { return a[1]; }

type CompVal<A> = [A, Node[]];

/** Run component and the now-computation inside */
export function runComponentNow<A>(parent: Node, c: Component<A>): A {
  return c.content(parent).run();
}

/**
 * A component is a function from a parent DOM node to a now
 * computation I.e. something like `type Component<A> = (p: Node) =>
 * Now<A>`. We don't define it as a type alias because we wan't to
 * make it a monad in different way than Now.
 */
export class Component<A> {
  constructor(public content: (n: Node) => Now<A>) {}
  static of<B>(b: B): Component<B> {
    return new Component(() => Now.of(b));
  }
  of: <B>(b: B) => Component<B> = Component.of;
  chain<B>(f: (a: A) => Component<B>): Component<B> {
    return new Component((parent: Node) => {
      return this.content(parent).chain((a) => {
        return f(a).content(parent);
      });
    });
  }
  flatten<B>(now: Component<Component<A>>): Component<A> {
    return now.chain(id);
  }
  map<B>(f: (a: A) => B): Component<B> {
    return this.chain((a: A) => this.of(f(a)));
  }
  mapTo<B>(b: B): Component<B> {
    return this.chain((_) => this.of(b));
  }
  lift<T1, R>(f: (t: T1) => R, m: Component<T1>): Component<R>;
  lift<T1, T2, R>(f: (t: T1, u: T2) => R, m1: Component<T1>, m2: Component<T2>): Component<R>;
  lift<T1, T2, T3, R>(f: (t1: T1, t2: T2, t3: T3) => R, m1: Component<T1>, m2: Component<T2>, m3: Component<T3>): Component<R>;
  lift(f: Function, ...ms: any[]): Component<any> {
    const {of} = ms[0];
    switch (f.length) {
    case 1:
      return ms[0].map(f);
    case 2:
      return ms[0].chain((a: any) => ms[1].chain((b: any) => of(f(a, b))));
    case 3:
      return ms[0].chain((a: any) => ms[1].chain((b: any) => ms[2].chain((c: any) => of(f(a, b, c)))));
    default:
      throw new Error("To many arguments");
    }
  }
}

export interface BehaviorObject {
  [a: string]: Behavior<any>;
}

const behaviorProxyHandler = {
  get: function (target: any, name: string): Behavior<any> {
    if (!(name in target)) {
      target[name] = placeholder();
    }
    return target[name];
  }
};

class MfixNow<M extends BehaviorObject, O> extends Now<[M, O]> {
  constructor(
    private fn: (m: M) => Now<[M, O]>,
    private toViewBehaviorNames?: string[]
  ) {
    super();
  };
  run(): [M, O] {
    let pregenerated: M;
    if (this.toViewBehaviorNames !== undefined) {
      for (const name of this.toViewBehaviorNames) {
        pregenerated[name] = placeholder();
      }
    }
    const placeholders = pregenerated || new Proxy({}, behaviorProxyHandler);
    const [behaviors, out] = this.fn(placeholders).run();
    // Tie the recursive knot
    for (const name in behaviors) {
      (placeholders[name]).replaceWith(behaviors[name]);
    }
    return [behaviors, out];
  };
}

export function isGeneratorFunction<A, T>(fn: any): fn is ((a: A) => Iterator<T>) {
  return fn !== undefined
    && fn.constructor !== undefined
    && fn.constructor.name === "GeneratorFunction";
}

export function component<M extends BehaviorObject, V, O>(
  model: ((v: V) => Now<[M, O]>) | ((v: V) => Iterator<Now<any>>),
  view:  ((m: M) => Component<V>) | ((m: M) => Iterator<Component<any>>),
  toViewBehaviorNames?: string[]
): Component<O> {
  const m = isGeneratorFunction(model) ? (v: V) => fgo(model)(v) : model;
  const v = isGeneratorFunction(view) ? (md: M) => fgo(view)(md) : view;
  return new Component<O>((parent: Node) => new MfixNow<M, O>(
    (bs) => v(bs).content(parent).chain(m),
    toViewBehaviorNames
  ).map(snd));
}

export function viewObserve<A>(update: (a: A) => void, behavior: Behavior<A>): void {
  let isPulling = false;
  observe(
    update,
    () => {
      isPulling = true;
      function pull(): void {
        update(behavior.pull());
        if (isPulling) {
          requestAnimationFrame(pull);
        }
      }
    },
    () => {
      isPulling = false;
    },
    behavior
  );
}

class SampleComponent<A> extends Now<Behavior<A>> {
  constructor(
    private parent: Node,
    private bComponent: Behavior<Component<A>>
  ) {super(); }
  run(): Behavior<A> {
    const start = document.createComment("Container start");
    const end = document.createComment("Container end");
    this.parent.appendChild(start);
    const resultB = sink(runComponentNow(this.parent, at(this.bComponent)));
    this.parent.appendChild(end);
    this.bComponent.subscribe((component) => {
      let i: Node = start.nextSibling;
      while (i !== end) {
        const j = i;
        i = i.nextSibling;
        this.parent.removeChild(j);
      }
      const fragment = document.createDocumentFragment();
      resultB.push(runComponentNow(fragment, component));
      this.parent.insertBefore(fragment, end);
    });
    return resultB;
  }
}

export function sampleComponent<A>(behavior: Behavior<Component<A>>): Component<Behavior<A>> {
  return new Component((p) => new SampleComponent(p, behavior));
}
