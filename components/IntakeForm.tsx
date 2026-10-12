"use client";

import { useActionState } from "react";
import { submitIdea, type FormState } from "@/app/new/actions";

const INITIAL: FormState = { errors: {}, values: {} };

export default function IntakeForm() {
  const [state, action, pending] = useActionState(submitIdea, INITIAL);
  const v = state.values;
  const err = (name: string) => state.errors[name] && <p className="err" id={`${name}-err`}>{state.errors[name]}</p>;
  const aria = (name: string) => (state.errors[name] ? { "aria-invalid": true, "aria-describedby": `${name}-err` } : {});

  return (
    <form action={action} className="intake" noValidate>
      <fieldset>
        <legend>Required</legend>

        <label htmlFor="idea">The idea <span>In 1 to 3 sentences: what it is and what it does.</span></label>
        <textarea id="idea" name="idea" rows={3} maxLength={600} required defaultValue={v.idea} {...aria("idea")}
          placeholder="A mobile grooming van that comes to your driveway, so dogs skip the salon." />
        {err("idea")}

        <label htmlFor="target_customer">Target customer <span>Who pays for it.</span></label>
        <input id="target_customer" name="target_customer" maxLength={200} required defaultValue={v.target_customer} {...aria("target_customer")}
          placeholder="Busy dog owners in suburban Halifax" />
        {err("target_customer")}

        <div className="row">
          <div>
            <label htmlFor="price">Price</label>
            <input id="price" name="price" maxLength={80} required defaultValue={v.price} {...aria("price")} placeholder="$80 per groom" />
            {err("price")}
          </div>
          <div>
            <label htmlFor="billing">Charged as</label>
            <select id="billing" name="billing" required defaultValue={v.billing ?? ""} {...aria("billing")}>
              <option value="" disabled>Choose…</option>
              <option value="one_time">One-time</option>
              <option value="subscription">Subscription</option>
              <option value="other">Other</option>
            </select>
            {err("billing")}
          </div>
        </div>

        <label htmlFor="geography">Where you sell <span>A country or city, or “online”.</span></label>
        <input id="geography" name="geography" maxLength={120} required defaultValue={v.geography} {...aria("geography")}
          placeholder="Halifax, NS" />
        {err("geography")}
      </fieldset>

      <fieldset>
        <legend>Optional</legend>

        <label htmlFor="known_competitors">Competitors you know of</label>
        <input id="known_competitors" name="known_competitors" maxLength={400} defaultValue={v.known_competitors} {...aria("known_competitors")} />
        {err("known_competitors")}

        <label htmlFor="biggest_worry">Your biggest worry</label>
        <input id="biggest_worry" name="biggest_worry" maxLength={400} defaultValue={v.biggest_worry} {...aria("biggest_worry")} />
        {err("biggest_worry")}

        <label htmlFor="stage">Stage</label>
        <select id="stage" name="stage" defaultValue={v.stage ?? ""} {...aria("stage")}>
          <option value="">Not saying</option>
          <option value="idea">Just an idea</option>
          <option value="building">Building it</option>
          <option value="launched">Launched</option>
        </select>
        {err("stage")}
      </fieldset>

      {err("form")}
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Start teardown"}</button>
    </form>
  );
}
