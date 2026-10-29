<!-- @spec billing/show-total -->
<script setup lang="ts">
import { computed } from 'vue';

function total(items: Item[]): number {
  return Math.round(items.reduce((n, i) => n + i.price, 0) * 100) / 100; // @spec billing/rounding
}

function addItem(items: Item[], item: Item): Item[] {
  // @spec billing/reject-empty
  if (item.qty === 0) throw new Error('empty');
  // @spec billing/reject-empty
  const next = [...items, item];
  // @spec billing/add-an-item

  return next;
}
</script>
