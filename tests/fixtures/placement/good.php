<?php
namespace App;

class Billing
{
    /**
     * Adds an item.
     * @spec billing/add-an-item
     */
    public function addItem(Cart $cart, Item $item): Cart
    {
        if ($item->qty === 0) {
            // @spec billing/reject-empty
            throw new \InvalidArgumentException('empty');
        }
        return $cart->with($item);
    }

    /**
     * Rounded total.
     * @spec billing/rounding
     */
    public function total(Cart $cart): float
    {
        return round($cart->sum(), 2);
    }
}
