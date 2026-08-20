export type DeferredReason =
  | Error
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | readonly DeferredReason[]
  | { readonly [key: string]: DeferredReason };

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: DeferredReason) => void;
};

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: DeferredReason) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
