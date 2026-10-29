# @spec billing/add-an-item
import os


def add_item(cart, item):
    cart.append(item)  # @spec billing/add-an-item
    return cart


def total(cart):
    # @spec billing/rounding
    s = sum(i.price for i in cart)
    # @spec billing/rounding
    r = round(s, 2)
    # @spec billing/reject-empty

    return r
