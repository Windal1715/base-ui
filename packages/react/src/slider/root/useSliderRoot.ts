'use client';
import * as React from 'react';
import { activeElement } from '@floating-ui/react/utils';
import { areArraysEqual } from '../../utils/areArraysEqual';
import { clamp } from '../../utils/clamp';
import { mergeReactProps } from '../../utils/mergeReactProps';
import { ownerDocument } from '../../utils/owner';
import { useControlled } from '../../utils/useControlled';
import { useEnhancedEffect } from '../../utils/useEnhancedEffect';
import { useForkRef } from '../../utils/useForkRef';
import { useBaseUiId } from '../../utils/useBaseUiId';
import { valueToPercent } from '../../utils/valueToPercent';
import type { CompositeMetadata } from '../../composite/list/CompositeList';
import type { TextDirection } from '../../direction-provider/DirectionContext';
import { useField } from '../../field/useField';
import { useFieldRootContext } from '../../field/root/FieldRootContext';
import { useFieldControlValidation } from '../../field/control/useFieldControlValidation';
import { percentToValue, roundValueToStep } from '../utils';
import { asc } from '../utils/asc';
import { setValueIndex } from '../utils/setValueIndex';
import { getSliderValue } from '../utils/getSliderValue';
import { ThumbMetadata } from '../thumb/useSliderThumb';

function findClosest(values: number[], currentValue: number) {
  const { index: closestIndex } =
    values.reduce<{ distance: number; index: number } | null>(
      (acc, value: number, index: number) => {
        const distance = Math.abs(currentValue - value);

        if (acc === null || distance < acc.distance || distance === acc.distance) {
          return {
            distance,
            index,
          };
        }

        return acc;
      },
      null,
    ) ?? {};
  return closestIndex;
}

export function focusThumb({
  sliderRef,
  activeIndex,
  setActive,
}: {
  sliderRef: React.RefObject<any>;
  activeIndex: number;
  setActive?: (num: number) => void;
}) {
  const doc = ownerDocument(sliderRef.current);
  if (
    !sliderRef.current?.contains(doc.activeElement) ||
    Number(doc?.activeElement?.getAttribute('data-index')) !== activeIndex
  ) {
    sliderRef.current?.querySelector(`[type="range"][data-index="${activeIndex}"]`).focus();
  }

  if (setActive) {
    setActive(activeIndex);
  }
}

export function validateMinimumDistance(
  values: number | readonly number[],
  step: number,
  minStepsBetweenValues: number,
) {
  if (!Array.isArray(values)) {
    return true;
  }

  const distances = values.reduce((acc: number[], val, index, vals) => {
    if (index === vals.length - 1) {
      return acc;
    }

    acc.push(Math.abs(val - vals[index + 1]));

    return acc;
  }, []);

  return Math.min(...distances) >= step * minStepsBetweenValues;
}

export function trackFinger(
  event: TouchEvent | PointerEvent | React.PointerEvent,
  touchIdRef: React.RefObject<any>,
) {
  // The event is TouchEvent
  if (touchIdRef.current !== undefined && (event as TouchEvent).changedTouches) {
    const touchEvent = event as TouchEvent;
    for (let i = 0; i < touchEvent.changedTouches.length; i += 1) {
      const touch = touchEvent.changedTouches[i];
      if (touch.identifier === touchIdRef.current) {
        return {
          x: touch.clientX,
          y: touch.clientY,
        };
      }
    }

    return false;
  }

  // The event is PointerEvent
  return {
    x: (event as PointerEvent).clientX,
    y: (event as PointerEvent).clientY,
  };
}

/**
 */
export function useSliderRoot(parameters: useSliderRoot.Parameters): useSliderRoot.ReturnValue {
  const {
    'aria-labelledby': ariaLabelledby,
    defaultValue,
    direction = 'ltr',
    disabled = false,
    id: idProp,
    largeStep = 10,
    max = 100,
    min = 0,
    minStepsBetweenValues = 0,
    name,
    onValueChange,
    onValueCommitted,
    orientation = 'horizontal',
    rootRef,
    step = 1,
    tabIndex,
    value: valueProp,
  } = parameters;

  const { setControlId, setTouched, setDirty, validityData } = useFieldRootContext();

  const {
    getValidationProps,
    inputRef: inputValidationRef,
    commitValidation,
  } = useFieldControlValidation();

  const [valueState, setValueState] = useControlled({
    controlled: valueProp,
    default: defaultValue ?? min,
    name: 'Slider',
  });

  const sliderRef = React.useRef<HTMLElement>(null);
  const controlRef: React.RefObject<HTMLElement | null> = React.useRef(null);
  const thumbRefs = React.useRef<(HTMLElement | null)[]>([]);

  const id = useBaseUiId(idProp);

  const [thumbMap, setThumbMap] = React.useState(
    () => new Map<Node, CompositeMetadata<ThumbMetadata> | null>(),
  );

  useEnhancedEffect(() => {
    setControlId(id);
    return () => {
      setControlId(undefined);
    };
  }, [id, setControlId]);

  useField({
    id,
    commitValidation,
    value: valueState,
    controlRef,
  });

  // We can't use the :active browser pseudo-classes.
  // - The active state isn't triggered when clicking on the rail.
  // - The active state isn't transferred when inversing a range slider.
  const [active, setActive] = React.useState(-1);

  const [dragging, setDragging] = React.useState(false);

  const registerSliderControl = React.useCallback(
    (element: HTMLElement | null) => {
      if (element) {
        controlRef.current = element;
        inputValidationRef.current = element.querySelector<HTMLInputElement>('input[type="range"]');
      }
    },
    [inputValidationRef],
  );

  const handleValueChange = React.useCallback(
    (value: number | number[], thumbIndex: number, event: Event | React.SyntheticEvent) => {
      if (!onValueChange) {
        return;
      }

      // Redefine target to allow name and value to be read.
      // This allows seamless integration with the most popular form libraries.
      // https://github.com/mui/material-ui/issues/13485#issuecomment-676048492
      // Clone the event to not override `target` of the original event.
      const nativeEvent = (event as React.SyntheticEvent).nativeEvent || event;
      // @ts-ignore The nativeEvent is function, not object
      const clonedEvent = new nativeEvent.constructor(nativeEvent.type, nativeEvent);

      Object.defineProperty(clonedEvent, 'target', {
        writable: true,
        value: { value, name },
      });

      onValueChange(value, clonedEvent, thumbIndex);
    },
    [name, onValueChange],
  );

  const range = Array.isArray(valueState);

  const values = React.useMemo(() => {
    return (range ? valueState.slice().sort(asc) : [valueState]).map((val) =>
      val == null ? min : clamp(val, min, max),
    );
  }, [max, min, range, valueState]);

  const handleRootRef = useForkRef(rootRef, sliderRef);

  const areValuesEqual = React.useCallback(
    (newValue: number | ReadonlyArray<number>): boolean => {
      if (typeof newValue === 'number' && typeof valueState === 'number') {
        return newValue === valueState;
      }
      if (typeof newValue === 'object' && typeof valueState === 'object') {
        return areArraysEqual(newValue, valueState);
      }
      return false;
    },
    [valueState],
  );

  const changeValue = React.useCallback(
    (valueInput: number, index: number, event: React.KeyboardEvent | React.ChangeEvent) => {
      const newValue = getSliderValue({
        valueInput,
        min,
        max,
        index,
        range,
        values,
      });

      if (range) {
        focusThumb({ sliderRef, activeIndex: index });
      }

      if (validateMinimumDistance(newValue, step, minStepsBetweenValues)) {
        setValueState(newValue);
        setDirty(newValue !== validityData.initialValue);

        if (handleValueChange && !areValuesEqual(newValue) && event) {
          handleValueChange(newValue, index, event);
        }

        setTouched(true);
        commitValidation(newValue);

        if (onValueCommitted && event) {
          onValueCommitted(newValue, event.nativeEvent);
        }
      }
    },
    [
      min,
      max,
      range,
      step,
      minStepsBetweenValues,
      values,
      setValueState,
      setDirty,
      validityData.initialValue,
      handleValueChange,
      areValuesEqual,
      onValueCommitted,
      setTouched,
      commitValidation,
    ],
  );

  const previousIndexRef = React.useRef<number | null>(null);

  const getFingerNewValue = React.useCallback(
    ({
      finger,
      move = false,
      offset = 0,
    }: {
      finger: { x: number; y: number };
      // `move` is used to distinguish between when this is called by touchstart vs touchmove/end
      move?: boolean;
      offset?: number;
    }) => {
      const { current: sliderControl } = controlRef;

      if (!sliderControl) {
        return null;
      }

      const isRtl = direction === 'rtl';
      const isVertical = orientation === 'vertical';

      const { width, height, bottom, left } = sliderControl!.getBoundingClientRect();
      let percent;

      if (isVertical) {
        percent = (bottom - finger.y) / height + offset;
      } else {
        percent = (finger.x - left) / width + offset * (isRtl ? -1 : 1);
      }

      percent = Math.min(percent, 1);

      if (isRtl && !isVertical) {
        percent = 1 - percent;
      }

      let newValue;
      newValue = percentToValue(percent, min, max);
      if (step) {
        newValue = roundValueToStep(newValue, step, min);
      }

      newValue = clamp(newValue, min, max);
      let activeIndex = 0;

      if (!range) {
        return { newValue, activeIndex, newPercentageValue: percent };
      }

      if (!move) {
        activeIndex = findClosest(values, newValue)!;
      } else {
        activeIndex = previousIndexRef.current!;
      }

      // Bound the new value to the thumb's neighbours.
      newValue = clamp(
        newValue,
        values[activeIndex - 1] + minStepsBetweenValues || -Infinity,
        values[activeIndex + 1] - minStepsBetweenValues || Infinity,
      );

      const previousValue = newValue;
      newValue = setValueIndex({
        values,
        newValue,
        index: activeIndex,
      });

      // Potentially swap the index if needed.
      if (!move) {
        activeIndex = newValue.indexOf(previousValue);
        previousIndexRef.current = activeIndex;
      }

      return { newValue, activeIndex, newPercentageValue: percent };
    },
    [direction, max, min, minStepsBetweenValues, orientation, range, step, values],
  );

  useEnhancedEffect(() => {
    const activeEl = activeElement(ownerDocument(sliderRef.current));
    if (disabled && sliderRef.current!.contains(activeEl)) {
      // This is necessary because Firefox and Safari will keep focus
      // on a disabled element:
      // https://codesandbox.io/p/sandbox/mui-pr-22247-forked-h151h?file=/src/App.js
      // @ts-ignore
      activeEl.blur();
    }
  }, [disabled]);

  if (disabled && active !== -1) {
    setActive(-1);
  }

  const getRootProps: useSliderRoot.ReturnValue['getRootProps'] = React.useCallback(
    (externalProps = {}) =>
      mergeReactProps(getValidationProps(externalProps), {
        'aria-labelledby': ariaLabelledby,
        id,
        ref: handleRootRef,
        role: 'group',
      }),
    [ariaLabelledby, getValidationProps, handleRootRef, id],
  );

  return React.useMemo(
    () => ({
      getRootProps,
      active,
      areValuesEqual,
      'aria-labelledby': ariaLabelledby,
      changeValue,
      direction,
      disabled,
      dragging,
      getFingerNewValue,
      handleValueChange,
      largeStep,
      max,
      min,
      minStepsBetweenValues,
      name,
      onValueCommitted,
      orientation,
      percentageValues: values.map((v) => valueToPercent(v, min, max)),
      range,
      registerSliderControl,
      setActive,
      setDragging,
      setThumbMap,
      setValueState,
      step,
      tabIndex,
      thumbMap,
      thumbRefs,
      values,
    }),
    [
      getRootProps,
      active,
      areValuesEqual,
      ariaLabelledby,
      changeValue,
      direction,
      disabled,
      dragging,
      getFingerNewValue,
      handleValueChange,
      largeStep,
      max,
      min,
      minStepsBetweenValues,
      name,
      onValueCommitted,
      orientation,
      range,
      registerSliderControl,
      setActive,
      setDragging,
      setThumbMap,
      setValueState,
      step,
      tabIndex,
      thumbMap,
      thumbRefs,
      values,
    ],
  );
}

export namespace useSliderRoot {
  export type Orientation = 'horizontal' | 'vertical';

  export interface Parameters {
    /**
     * The id of the slider element.
     */
    id?: string;
    /**
     * The id of the element containing a label for the slider.
     */
    'aria-labelledby'?: string;
    /**
     * The default value. Use when the component is not controlled.
     */
    defaultValue?: number | ReadonlyArray<number>;
    /**
     * Sets the direction. For right-to-left languages, the lowest value is on the right-hand side.
     * @default 'ltr'
     */
    direction: TextDirection;
    /**
     * Whether the component should ignore user interaction.
     * @default false
     */
    disabled?: boolean;
    /**
     * The maximum allowed value of the slider.
     * Should not be equal to min.
     * @default 100
     */
    max?: number;
    /**
     * The minimum allowed value of the slider.
     * Should not be equal to max.
     * @default 0
     */
    min?: number;
    /**
     * The minimum steps between values in a range slider.
     * @default 0
     */
    minStepsBetweenValues?: number;
    /**
     * Identifies the field when a form is submitted.
     */
    name?: string;
    /**
     * Callback function that is fired when the slider's value changed.
     *
     * @param {number | number[]} value The new value.
     * @param {Event} event The corresponding event that initiated the change.
     * You can pull out the new value by accessing `event.target.value` (any).
     * @param {number} activeThumbIndex Index of the currently moved thumb.
     */
    onValueChange?: (value: number | number[], event: Event, activeThumbIndex: number) => void;
    /**
     * Callback function that is fired when the `pointerup` is triggered.
     *
     * @param {number | number[]} value The new value.
     * @param {Event} event The corresponding event that initiated the change.
     * **Warning**: This is a generic event not a change event.
     */
    onValueCommitted?: (value: number | number[], event: Event) => void;
    /**
     * The component orientation.
     * @default 'horizontal'
     */
    orientation?: Orientation;
    /**
     * The ref attached to the root of the Slider.
     */
    rootRef?: React.Ref<Element>;
    /**
     * The granularity with which the slider can step through values when using Page Up/Page Down or Shift + Arrow Up/Arrow Down.
     * @default 10
     */
    largeStep?: number;
    /**
     * The granularity with which the slider can step through values. (A "discrete" slider.)
     * The `min` prop serves as the origin for the valid values.
     * We recommend (max - min) to be evenly divisible by the step.
     * @default 1
     */
    step?: number;
    /**
     * Tab index attribute of the Thumb component's `input` element.
     */
    tabIndex?: number;
    /**
     * The value of the slider.
     * For ranged sliders, provide an array with two values.
     */
    value?: number | ReadonlyArray<number>;
  }

  export interface ReturnValue {
    getRootProps: (
      externalProps?: React.ComponentPropsWithRef<'div'>,
    ) => React.ComponentPropsWithRef<'div'>;
    /**
     * The index of the active thumb.
     */
    active: number;
    /**
     * A function that compares a new value with the internal value of the slider.
     * The internal value is potentially unsorted, e.g. to support frozen arrays: https://github.com/mui/material-ui/pull/28472
     */
    areValuesEqual: (newValue: number | ReadonlyArray<number>) => boolean;
    'aria-labelledby'?: string;
    changeValue: (
      valueInput: number,
      index: number,
      event: React.KeyboardEvent | React.ChangeEvent,
    ) => void;
    dragging: boolean;
    direction: TextDirection;
    disabled: boolean;
    getFingerNewValue: (args: {
      finger: { x: number; y: number };
      move?: boolean;
      offset?: number;
      activeIndex?: number;
    }) => { newValue: number | number[]; activeIndex: number; newPercentageValue: number } | null;
    handleValueChange: (
      value: number | number[],
      activeThumb: number,
      event: React.SyntheticEvent | Event,
    ) => void;
    /**
     * The large step value of the slider when incrementing or decrementing while the shift key is held,
     * or when using Page-Up or Page-Down keys. Snaps to multiples of this value.
     * @default 10
     */
    largeStep: number;
    /**
     * The maximum allowed value of the slider.
     */
    max: number;
    /**
     * The minimum allowed value of the slider.
     */
    min: number;
    /**
     * The minimum steps between values in a range slider.
     */
    minStepsBetweenValues: number;
    name?: string;
    onValueCommitted?: (value: number | number[], event: Event) => void;
    /**
     * The component orientation.
     * @default 'horizontal'
     */
    orientation: Orientation;
    registerSliderControl: (element: HTMLElement | null) => void;
    /**
     * The value(s) of the slider as percentages
     */
    percentageValues: readonly number[];
    setActive: (activeIndex: number) => void;
    setDragging: (isDragging: boolean) => void;
    setThumbMap: (map: Map<Node, CompositeMetadata<ThumbMetadata> | null>) => void;
    setValueState: (newValue: number | number[]) => void;
    /**
     * The step increment of the slider when incrementing or decrementing. It will snap
     * to multiples of this value. Decimal values are supported.
     * @default 1
     */
    step: number;
    thumbMap: Map<Node, CompositeMetadata<ThumbMetadata> | null>;
    thumbRefs: React.MutableRefObject<(HTMLElement | null)[]>;
    tabIndex?: number;
    /**
     * The value(s) of the slider
     */
    values: readonly number[];
  }
}
