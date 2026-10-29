<?php
// @spec billing/add-an-item
namespace App;

class Billing
{
    public function addItem(Cart $cart, Item $item): Cart
    {
        $next = $cart->with($item); // @spec billing/add-an-item
        return $next;
    }

    public function total(Cart $cart): float
    {
        // @spec billing/rounding
        $s = $cart->sum();
        // @spec billing/rounding
        $r = round($s, 2);
        // @spec billing/reject-empty

        return $r;
    }
}
