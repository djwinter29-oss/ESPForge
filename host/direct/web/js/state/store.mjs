// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Minimal observable store; the board session dispatches and the dashboard subscribes. */

import { dashboardReducer, INITIAL_STATE } from "./reducer.mjs";

/**
 * @template State, Action
 * @param {(state: State, action: Action) => State} reducer
 * @param {State} initial
 */
export function createStore(reducer, initial) {
  let state = initial;
  /** @type {Set<(state: State) => void>} */
  const listeners = new Set();
  return {
    getState: () => state,
    /** @param {Action} action */
    dispatch(action) {
      const next = reducer(state, action);
      if (next === state) return state;
      state = next;
      for (const listener of listeners) listener(state);
      return state;
    },
    /** @param {(state: State) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** @typedef {ReturnType<typeof createDashboardStore>} DashboardStore */

export const createDashboardStore = () => createStore(dashboardReducer, { ...INITIAL_STATE });
