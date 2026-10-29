// @spec billing/add-an-item
package app;

public class Bad {
    public Cart addItem(Cart cart, Item item) {
        Cart next = cart.with(item); // @spec billing/add-an-item
        return next;
    }

    public double total(Cart cart) {
        // @spec billing/rounding
        double s = cart.sum();
        // @spec billing/rounding
        double r = Math.round(s * 100) / 100.0;
        // @spec billing/reject-empty

        return r;
    }
}
