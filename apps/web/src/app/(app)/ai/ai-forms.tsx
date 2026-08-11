'use client';

import { useActionState } from 'react';

import {
  configureAiAction,
  removeAiAction,
  setAiEnabledAction,
  testAiAction,
  type AiFormState,
} from '../../actions/ai';
import { Button, Field, Notice, TextInput } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';

/**
 * The forms behind the AI settings screen (sections 18, 19, 21).
 *
 * The order of the controls is the order of section 18's rules: describe the
 * endpoint, prove it answers, and only then switch it on. The switch is drawn
 * disabled until the endpoint has answered, and the server refuses the same
 * thing again — the control is a courtesy, never the rule.
 *
 * The credential box is always empty, whatever is stored. Section 19 requires a
 * secret to be "masked after entry, never returned to the browser", and the
 * honest form of that on a form is a box that never held the value in the first
 * place; leaving it empty keeps whatever is stored.
 */

const IDLE: AiFormState = { status: 'idle' };

function Message({ state }: { state: AiFormState }) {
  if (state.message === undefined) {
    return null;
  }

  return <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>;
}

export interface ConfigurationValues {
  readonly kind: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly requestTimeoutMs: number;
  readonly maxOutputTokens: number;
  readonly monthlyRequestCap: number;
  readonly monthlyTokenCap: number;
  readonly imageAnalysisEnabled: boolean;
  readonly retainPrompts: boolean;
  readonly costCurrency: string;
  readonly costPerMillionInputTokens: string;
  readonly costPerMillionOutputTokens: string;
  readonly monthlyCostCapAmount: string;
}

export function ConfigurationForm({
  csrf,
  businessId,
  values,
  hasCredential,
  privateHostsAllowed,
}: {
  csrf: string;
  businessId: string;
  values: ConfigurationValues;
  hasCredential: boolean;
  privateHostsAllowed: boolean;
}) {
  const [state, submit, pending] = useActionState(configureAiAction, IDLE);

  return (
    <form action={submit} className="flex flex-col gap-4">
      <Message state={state} />
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />

      <Field label="Kind">
        <select
          name="kind"
          defaultValue={values.kind}
          className="rounded-md border border-black/20 bg-transparent px-3 py-2 text-base dark:border-white/25"
        >
          <option value="openai_compatible">OpenAI-compatible endpoint</option>
          <option value="ollama">Ollama</option>
        </select>
      </Field>

      <Field
        label="Endpoint address"
        hint={
          privateHostsAllowed
            ? 'This installation allows private addresses, so a local Ollama may be named here.'
            : 'HTTPS, and a public address. Private addresses need an installation-level exception.'
        }
      >
        <TextInput name="baseUrl" defaultValue={values.baseUrl} required inputMode="url" />
      </Field>

      <Field label="Model">
        <TextInput name="model" defaultValue={values.model} required />
      </Field>

      <Field
        label="API key"
        hint={
          hasCredential
            ? 'A key is stored. Leave this empty to keep it, or type a new one to replace it.'
            : 'Optional. A local Ollama usually needs none.'
        }
      >
        <TextInput name="apiKey" type="password" autoComplete="off" placeholder="" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Timeout (ms)">
          <TextInput
            name="requestTimeoutMs"
            defaultValue={String(values.requestTimeoutMs)}
            inputMode="numeric"
          />
        </Field>
        <Field label="Longest answer (tokens)">
          <TextInput
            name="maxOutputTokens"
            defaultValue={String(values.maxOutputTokens)}
            inputMode="numeric"
          />
        </Field>
        <Field label="Suggestions a month" hint="There is always a ceiling; it cannot be removed.">
          <TextInput
            name="monthlyRequestCap"
            defaultValue={String(values.monthlyRequestCap)}
            inputMode="numeric"
          />
        </Field>
        <Field label="Tokens a month">
          <TextInput
            name="monthlyTokenCap"
            defaultValue={String(values.monthlyTokenCap)}
            inputMode="numeric"
          />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-2 rounded-md border border-black/10 p-4 dark:border-white/15">
        <legend className="px-1 text-sm font-medium">Money</legend>
        <p className="text-xs opacity-70">
          Only a paid endpoint has any. Enter the rates from your provider&rsquo;s price list; a
          spending limit is only enforceable once they are here, so a limit without them is refused
          rather than displayed.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currency">
            <TextInput name="costCurrency" defaultValue={values.costCurrency} maxLength={3} />
          </Field>
          <Field label="Monthly limit">
            <TextInput
              name="monthlyCostCapAmount"
              defaultValue={values.monthlyCostCapAmount}
              inputMode="decimal"
            />
          </Field>
          <Field label="Per million input tokens">
            <TextInput
              name="costPerMillionInputTokens"
              defaultValue={values.costPerMillionInputTokens}
              inputMode="decimal"
            />
          </Field>
          <Field label="Per million output tokens">
            <TextInput
              name="costPerMillionOutputTokens"
              defaultValue={values.costPerMillionOutputTokens}
              inputMode="decimal"
            />
          </Field>
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="imageAnalysisEnabled"
          defaultChecked={values.imageAnalysisEnabled}
        />
        <span>
          Allow product photographs to be sent, when a request asks for it. Off by default, and a
          request must still ask.
        </span>
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="retainPrompts" defaultChecked={values.retainPrompts} />
        <span>
          Keep the text of each question and answer, for debugging. Off by default; nothing is
          retained unless this is on.
        </span>
      </label>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

export function EndpointControls({
  csrf,
  businessId,
  enabled,
  ready,
}: {
  csrf: string;
  businessId: string;
  enabled: boolean;
  ready: boolean;
}) {
  const [testState, test, testing] = useActionState(testAiAction, IDLE);
  const [switchState, setEnabled, switching] = useActionState(setAiEnabledAction, IDLE);
  const [removeState, remove, removing] = useActionState(removeAiAction, IDLE);

  return (
    <div className="flex flex-col gap-3">
      <Message state={testState} />
      <Message state={switchState} />
      <Message state={removeState} />

      <div className="flex flex-wrap gap-3">
        <form action={test}>
          <input type="hidden" name={CSRF_FIELD} value={csrf} />
          <input type="hidden" name="businessId" value={businessId} />
          <Button type="submit" variant="secondary" disabled={testing}>
            {testing ? 'Asking…' : 'Test the endpoint'}
          </Button>
        </form>

        <form action={setEnabled}>
          <input type="hidden" name={CSRF_FIELD} value={csrf} />
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
          <Button type="submit" disabled={switching || (!enabled && !ready)}>
            {enabled ? 'Switch off' : 'Switch on'}
          </Button>
        </form>

        <form action={remove}>
          <input type="hidden" name={CSRF_FIELD} value={csrf} />
          <input type="hidden" name="businessId" value={businessId} />
          <Button type="submit" variant="secondary" disabled={removing}>
            Remove and destroy the key
          </Button>
        </form>
      </div>

      {!enabled && !ready ? (
        <p className="text-sm opacity-70">
          Test the endpoint before switching it on. An endpoint that has never answered would offer
          the feature on every screen and fail the first time somebody used it.
        </p>
      ) : null}
    </div>
  );
}
