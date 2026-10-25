"use node";

import { Stripe } from "stripe";
import { v } from "convex/values";

import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

// The old top-level field when present (old-version payloads), otherwise the new location.
function getInvoiceSubscription<T extends object>(invoice: T): InvoiceSubscription<T> {
  const legacy: unknown = Reflect.get(invoice, 'subscription');
  const parent: unknown = Reflect.get(invoice, 'parent');
  const details: unknown =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved: unknown =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as InvoiceSubscription<T>;
}

const url = process.env.NEXT_PUBLIC_APP_URL!;
const stripe = new Stripe(process.env.STRIPE_API_KEY!, {
  apiVersion: "2026-09-30.endive",
});

/**
 * Allow users to cancel their subscription
 */
export const portal = action({
  args: { orgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      throw new Error("Unauthorized");
    }

    if (!args.orgId) {
      throw new Error("No organization Id");
    }

    const orgSubscription = await ctx.runQuery(internal.subscriptions.get, {
      orgId: args.orgId,
    });

    if (!orgSubscription) {
      throw new Error("No subscription found");
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: orgSubscription.stripeCustomerId,
      return_url: url, // Next_public_app_url
    });
    return session.url;
  },
});

export const pay = action({
  args: {
    orgId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized");
    }
    if (!args.orgId) {
      throw new Error("No organization Id");
    }
    const session = await stripe.checkout.sessions.create({
      success_url: url,
      cancel_url: url,
      customer_email: identity.email,
      line_items: [
        {
          price_data: {
            currency: "USD",
            product_data: {
              name: "Board Pro",
              description: "Unlimited boards for your organization",
            },
            unit_amount: 2000, // $ 20
            recurring: {
              interval: "month",
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        orgId: args.orgId,
        // payments are done using webhooks so that's why we need to pass the orgId as metadata
        // payments are not done using promises
        // Payments confirmation comes on the webhook and backend needs to know which orgId to update
      },
      mode: "subscription",
    });

    return session.url;
  },
});

export const fulfill = internalAction({
  args: {
    signature: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, { signature, payload }) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET as string;
    try {
      const event = stripe.webhooks.constructEvent(
        payload,
        signature,
        webhookSecret
      );
      const session = event.data.object as Stripe.Checkout.Session;

      if (event.type === "checkout.session.completed") {
        // 1s time payment callback
        const subscription = await stripe.subscriptions.retrieve(
          session.subscription as string
        );

        if (!session?.metadata?.orgId) {
          throw new Error("No orgId in metadata");
        }

        await ctx.runMutation(internal.subscriptions.create, {
          orgId: session.metadata.orgId as string,
          stripeCustomerId: session.customer as string,
          stripeSubscriptionId: subscription.id as string,
          stripePriceId: subscription.items.data[0].price.id as string,
          stripeCurrentPeriodEnd: ((getSubscriptionPeriodEnd(subscription, (items) => items[0])) *
            1000) as number,
        });
      }

      if (event.type === "invoice.payment_succeeded") {
        // when stripe tries to renew the subscription
        // we need less info here
        const subscription = await stripe.subscriptions.retrieve(
          (getInvoiceSubscription(session)) as string
        );

        await ctx.runMutation(internal.subscriptions.update, {
          stripeSubscriptionId: subscription.id as string,
          stripeCurrentPeriodEnd: ((getSubscriptionPeriodEnd(subscription, (items) => items[0])) *
            1000) as number,
        });
      }

      return { success: true };
    } catch (err) {
      console.error(err);
      return { success: false };
    }
  },
});
