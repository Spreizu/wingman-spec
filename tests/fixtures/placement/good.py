import os


def add_item(cart, item):
    """Add an item to the cart.

    @spec billing/add-an-item
    """
    if not item:
        raise ValueError("no item")
    # @spec billing/reject-empty
    if item.qty == 0:
        raise ValueError("empty")
    cart.append(item)
    return cart


def total(cart):
    # @spec billing/rounding
    return round(sum(i.price for i in cart), 2)
