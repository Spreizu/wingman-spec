<template>
  <!-- @spec billing/show-total -->
  <p data-testid="total">{{ total }}</p>
</template>

<script setup lang="ts">
/**
 * Total of the cart.
 * @spec billing/rounding
 */
function total(items: Item[]): number {
  return Math.round(items.reduce((n, i) => n + i.price, 0) * 100) / 100;
}

function addItem(items: Item[], item: Item): Item[] {
  // @spec billing/reject-empty
  if (item.qty === 0) throw new Error('empty');
  return [...items, item];
}
</script>
