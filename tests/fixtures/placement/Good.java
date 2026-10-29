package app;

public class Good {
    /**
     * Adds an item.
     * @spec billing/add-an-item
     */
    public Cart addItem(Cart cart, Item item) {
        if (item.qty() == 0) {
            // @spec billing/reject-empty
            throw new IllegalArgumentException("empty");
        }
        return cart.with(item);
    }

    /**
     * Rounded total.
     * @spec billing/rounding
     */
    public double total(Cart cart) {
        return Math.round(cart.sum() * 100) / 100.0;
    }
}
